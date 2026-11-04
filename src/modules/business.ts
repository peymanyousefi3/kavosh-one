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
import { agreementPackages,packageActions,packagesContract } from './agreement-packages.ts';
import { files,filesContract } from './files.ts';
import { storage,storageActions,storageContract } from './storage.ts';
import { finance,financeActions,financeContract } from './finance.ts';
import { financeTaxes,taxActions,taxesContract } from './finance-taxes.ts';
import { paymentMethods,paymentMethodActions,paymentMethodsContract } from './payment-methods.ts';
import { tuition,tuitionActions,tuitionContract } from './tuition.ts';
import { invoices,invoiceActions,invoicesContract } from './invoices.ts';
import { financePeriods,periodActions,periodsContract } from './finance-periods.ts';
import { financeJournals,journalActions,journalsContract } from './finance-journals.ts';
import { financeLedger,ledgerContract } from './finance-ledger.ts';
import { financialReports,financialReportsContract } from './financial-reports.ts';
import { financialStatements,financialStatementsContract } from './financial-statements.ts';
import { financeClosing,closingContract } from './finance-closing.ts';
import { financeClosingRuns,closingActions,closingRunsContract } from './finance-closing-runs.ts';
import type { R2UploadConnections } from '../integrations/r2-config.ts';

// All modules use the same authentication, scopes, transaction, audit and
// approval registry. No endpoint gets a parallel, weaker authorization path.
const approvalActions={...administrationActions,...sessionActions,...familyActions,...enrollmentActions,...agreementActions,...packageActions,...storageActions,...financeActions,...taxActions,...paymentMethodActions,...tuitionActions,...invoiceActions,...periodActions,...journalActions,...closingActions};
export async function business(ctx:ApiContext,connections?:R2UploadConnections):Promise<Reply|null> {
  const signatureReply=await agreementPackages(ctx,approvalActions);if(signatureReply)return signatureReply;
  const methodReply=await paymentMethods(ctx,approvalActions);if(methodReply)return methodReply;
  const tuitionReply=await tuition(ctx,approvalActions);if(tuitionReply)return tuitionReply;
  const invoiceReply=await invoices(ctx,approvalActions);if(invoiceReply)return invoiceReply;
  return await administration(ctx,approvalActions)??await academy(ctx)??await calendar(ctx)??await classes(ctx,approvalActions)??await staff(ctx)??await students(ctx)??await guardians(ctx)??await families(ctx,approvalActions)??await enrollments(ctx,approvalActions)??await agreements(ctx,approvalActions)??await files(ctx)??await storage(ctx,approvalActions,connections)??await financeTaxes(ctx,approvalActions)??await finance(ctx,approvalActions)??await financePeriods(ctx,approvalActions)??await financeJournals(ctx,approvalActions)??await financeLedger(ctx)??await financialReports(ctx)??await financialStatements(ctx)??await financeClosing(ctx)??await financeClosingRuns(ctx,approvalActions);
}
export const businessContract=[...coreContract,...administrationContract,...academyContract,...calendarContract,...classesContract,...staffContract,...studentsContract,...guardiansContract,...familiesContract,...enrollmentsContract,...agreementsContract,...packagesContract,...filesContract,...storageContract,...financeContract,...taxesContract,...paymentMethodsContract,...tuitionContract,...invoicesContract,...periodsContract,...journalsContract,...ledgerContract,...financialReportsContract,...financialStatementsContract,...closingContract,...closingRunsContract];
