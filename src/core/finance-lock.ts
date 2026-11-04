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
export async function lockClosingBook(ctx:ApiContext){
 if(ctx.financeBookExclusive)return;
 if(ctx.financeBookLocked)throw new Error('FINANCE_LOCK_UPGRADE_FORBIDDEN');
 if(ctx.policyLock!=='exclusive')throw new Error('FINANCE_CLOSING_POLICY_REQUIRED');
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,10))',[ctx.credential.academy_id]);
 ctx.financeBookLocked=true;ctx.financeBookExclusive=true;
}
