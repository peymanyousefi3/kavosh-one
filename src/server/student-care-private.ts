import 'server-only';
import { createPayrollPrivateVault,type PayrollPrivateVault } from '../core/payroll-private-data.ts';

let instance:PayrollPrivateVault|undefined;
// Separate managed keys and authenticated domain;no payroll key fallback.
export function getStudentCareVault(){if(instance)return instance;try{const raw=process.env.STUDENT_CARE_PRIVATE_KEYS;if(!raw||raw.length>4096)throw new Error('UNCONFIGURED');return instance=createPayrollPrivateVault({activeKeyId:process.env.STUDENT_CARE_PRIVATE_ACTIVE_KEY_ID,keys:JSON.parse(raw),fingerprintKey:process.env.STUDENT_CARE_PRIVATE_FINGERPRINT_KEY},'student-care');}catch{throw new Error('STUDENT_CARE_PRIVATE_CONFIG_INVALID');}}
