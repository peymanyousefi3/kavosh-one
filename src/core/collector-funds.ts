import type { ApiContext } from './api.ts';

// Policy -> book -> topology -> collector funds -> invoice/receipt/account
// rows. Keep this before explicit rows in every money-changing caller.
export async function lockCollectorFunds(ctx:ApiContext,collectorId:string,holdingAccountId:string){
 const key=collectorId+':'+holdingAccountId;if(ctx.collectorFundLocks?.has(key))return;
 await ctx.db.query('SELECT public.lock_collector_funds($1,$2)',[collectorId,holdingAccountId]);
 (ctx.collectorFundLocks??=new Set()).add(key);
}
