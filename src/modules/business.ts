import { coreContract,type ApiContext,type Reply } from '../core/api.ts';
import { administration,administrationActions,administrationContract } from './administration.ts';
import { academy,academyContract } from './academy.ts';
import { calendar,calendarContract } from './calendar.ts';
import { classes,classesContract,sessionActions } from './classes.ts';
import { staff,staffContract } from './staff.ts';
import { students,studentsContract } from './students.ts';
import { guardians,guardiansContract } from './guardians.ts';
import { families,familyActions,familiesContract } from './families.ts';
import { enrollments,enrollmentActions,enrollmentsContract } from './enrollments.ts';
import { agreements,agreementActions,agreementsContract } from './agreements.ts';
import { files,filesContract } from './files.ts';
import { storage,storageActions,storageContract } from './storage.ts';
import { finance,financeActions,financeContract } from './finance.ts';
import { financePeriods,periodActions,periodsContract } from './finance-periods.ts';
import { financeJournals,journalActions,journalsContract } from './finance-journals.ts';
import type { R2UploadConnections } from '../integrations/r2-config.ts';

// All modules use the same authentication, scopes, transaction, audit and
// approval registry. No endpoint gets a parallel, weaker authorization path.
const approvalActions={...administrationActions,...sessionActions,...familyActions,...enrollmentActions,...agreementActions,...storageActions,...financeActions,...periodActions,...journalActions};
export async function business(ctx:ApiContext,connections?:R2UploadConnections):Promise<Reply|null> {
  return await administration(ctx,approvalActions)??await academy(ctx)??await calendar(ctx)??await classes(ctx,approvalActions)??await staff(ctx)??await students(ctx)??await guardians(ctx)??await families(ctx,approvalActions)??await enrollments(ctx,approvalActions)??await agreements(ctx,approvalActions)??await files(ctx)??await storage(ctx,approvalActions,connections)??await finance(ctx,approvalActions)??await financePeriods(ctx,approvalActions)??await financeJournals(ctx,approvalActions);
}
export const businessContract=[...coreContract,...administrationContract,...academyContract,...calendarContract,...classesContract,...staffContract,...studentsContract,...guardiansContract,...familiesContract,...enrollmentsContract,...agreementsContract,...filesContract,...storageContract,...financeContract,...periodsContract,...journalsContract];
