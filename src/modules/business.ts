import type { ApiContext,Reply } from '../core/api.ts';
import { administration,administrationActions,administrationContract } from './administration.ts';
import { academy,academyContract } from './academy.ts';
import { calendar,calendarContract } from './calendar.ts';
import { classes,classesContract,sessionActions } from './classes.ts';

// All modules use the same authentication, scopes, transaction, audit and
// approval registry. No endpoint gets a parallel, weaker authorization path.
const approvalActions={...administrationActions,...sessionActions};
export async function business(ctx:ApiContext):Promise<Reply|null> {
  return await administration(ctx,approvalActions)??await academy(ctx)??await calendar(ctx)??await classes(ctx,approvalActions);
}
export const businessContract=[...administrationContract,...academyContract,...calendarContract,...classesContract];
