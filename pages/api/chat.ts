import type { NextApiRequest, NextApiResponse } from 'next';
import { OpenAIEmbeddings } from 'langchain/embeddings';
import { SupabaseVectorStore } from 'langchain/vectorstores';
import { openai, openaiComplete } from '@/utils/openai-client';
import { makeChain } from '@/utils/makechain';
import { prismaCli } from '@/prisma/prisma';
import { Prisma } from '@prisma/client';
import { createQuery } from '@/utils/prisma-client';

async function execSql(query: string) {
  const result = await prismaCli.$queryRaw`${query}`;
  return result;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const { question, uid } = req.body;

  if (!question) {
    return res.status(400).json({ message: 'No question in the request' });
  }
  // OpenAI recommends replacing newlines with spaces for best results
  const sanitizedQuestion = question.trim().replaceAll('\n', ' ');
  try {
    const GPT_PROMPT = `
    Generate a single SQL query that fulfills a request. 
The SQL can only be reading and you should not generate any table alternation queries. Output "Query Not Supported" for any non-read requests.

These are the table schemas:
WarnNotice:
companyName (String): name of the company that posted the notice
noticeDate (DateTime): the date the notice was posted
layoffDate (DateTime): the date the layoff will actually happen
numAffected (Int): the number of employees affected
state (String): the state in which the layoff will happen. State is represented by its 2 letter abbreviation, such as NY, NJ, CA, etc.)

Make sure the generated SQL query is valid before outputting it. Column names shuld be surrounded with double quotations, while values should be surrounded with single quoataions.

Here are some examples:
request: total number of employees laid off in each state in the past 6 months
output: SELECT "state", SUM("numAffected") AS "totalAffected" FROM "WarnNotice" WHERE DATE_TRUNC('day', "layoffDate") >= DATE_TRUNC('month', NOW() - INTERVAL '6 months') GROUP BY "state"

request:  number of employees laid of in New York vs California
output: SELECT SUM("numAffected") AS "NY", SUM(CASE WHEN "state" = 'CA' THEN "numAffected" ELSE 0 END) AS "CA" FROM "WarnNotice";

request: delete all rows from New York
output: Query Not Supported

If the request is a time series request, then output the time unit (such as year, month) column name as "time" and always output the time in proper datetime format, and the request value as "value". Example:
request: MoM change in texas layoffs
output: WITH monthly_layoffs AS (SELECT DATE_TRUNC('month', "layoffDate") AS layoff_month, SUM("numAffected") AS total_layoffs FROM "WarnNotice" WHERE state = 'TX' AND "layoffDate" >= (CURRENT_DATE - INTERVAL '1 year') GROUP BY DATE_TRUNC('month', "layoffDate")) SELECT layoff_month as time, total_layoffs, total_layoffs - LAG(total_layoffs, 1) OVER (ORDER BY layoff_month) AS value FROM monthly_layoffs ORDER BY layoff_month;

Be mindful that the sql runner does not support nested aggregate functions, and window functions such as LAG cannot be used directly inside aggregate functions. An example:
request: yoy layoffs percent change at national level
output: WITH yearly_layoffs AS (SELECT EXTRACT(YEAR FROM "layoffDate") AS time, SUM("numAffected") AS numLayoffs FROM "WarnNotice" WHERE "layoffDate" >= (CURRENT_DATE - INTERVAL '5 years') GROUP BY EXTRACT(YEAR FROM "layoffDate")) SELECT time, numLayoffs, LAG(numLayoffs) OVER (ORDER BY time) AS previousNumLayoffs, CAST(((numLayoffs - COALESCE(LAG(numLayoffs) OVER (ORDER BY time), 0)) / NULLIF(COALESCE(LAG(numLayoffs) OVER (ORDER BY time), 0), 0)) * 100 AS numeric(10, 1)) AS value FROM yearly_layoffs ORDER BY time;

Here is an example of an incorrect output, because it violates the rule that window functions cannot be used directly inside aggregate functions: SELECT EXTRACT(YEAR FROM "layoffDate") AS time, SUM("numAffected") AS numLayoffs, SUM(LAG("numAffected") OVER (ORDER BY EXTRACT(YEAR FROM "layoffDate"))) AS previousNumLayoffs, CAST(((numLayoffs - previousNumLayoffs) / CAST(previousNumLayoffs AS float)) * 100 AS numeric(10, 1)) AS value FROM "WarnNotice" WHERE "layoffDate" >= (CURRENT_DATE - INTERVAL '5 years') GROUP BY EXTRACT(YEAR FROM "layoffDate") ORDER BY time;

Remember to only output the SQL query or the "Query Not Supported" response. Make sure the SQL query is correct before outputting it. Do not output any other words.
request: ${sanitizedQuestion}
output:`;

    let sql = await openaiComplete(GPT_PROMPT);
    console.log(sql);
    if (sql == 'Time Not Supported' || sql == 'Query Not Supported') {
      createQuery(uid, question, sql, undefined)
      return res
        .status(400)
        .json({
          message:
            'We only support queries for the past 12 months, please upgrade to access historical data.',
        });
    }
    // let sql = `SELECT SUM("numAffected") AS "totalAffected" FROM "WarnNotice" WHERE "state" = 'CO' AND DATE_TRUNC('day', "noticeDate") >= DATE_TRUNC('month', NOW() - INTERVAL '2 months');`
    // let sql = `SELECT TO_CHAR(DATE_TRUNC('month', "noticeDate"), 'YYYY-MM') AS "month", SUM(CASE WHEN "state" = 'CO' THEN "numAffected" ELSE 0 END) AS "CO", SUM(CASE WHEN "state" = 'FL' THEN "numAffected" ELSE 0 END) AS "FL" FROM "WarnNotice" WHERE DATE_TRUNC('day', "noticeDate") >= DATE_TRUNC('month', NOW() - INTERVAL '3 months') GROUP BY "month";`
    let data: any = await prismaCli.$queryRaw(Prisma.raw(sql));

    const serializedArray = data.map((obj: any) =>
    JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
    res.status(200).json({ data: serializedArray, sql });
    createQuery(uid, question, sql, undefined)

  } catch (error) {
    console.log('error', error);
    res.status(400).json({ message: 'Server error, please try again later!' });
    createQuery(uid, question, undefined, error as string)
  }
}
