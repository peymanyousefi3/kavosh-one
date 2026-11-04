import type { ApiContext } from './api.ts';

// Call only after current feature/data authorization, before explicit finance
// row locks. Policy -> book -> topology -> row order is shared by API writers.
// Closing must take the exclusive book gate at the outset, never upgrade this
// shared gate in place. Native statement triggers also cover direct DML.
export async function lockFinanceBook(ctx:ApiContext){
 if(ctx.financeBookLocked)return;
 await ctx.db.query('SELECT public.lock_finance_book()');
 ctx.financeBookLocked=true;
}
