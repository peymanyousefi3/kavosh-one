import 'server-only';
import { createPayrollPrivateVault,type PayrollPrivateVault } from '../core/payroll-private-data.ts';

let instance:PayrollPrivateVault|undefined;
// Lazy: ordinary routes/builds do not need these separately managed secrets.
export function getPayrollPrivateVault(){if(instance)return instance;try{const raw=process.env.PAYROLL_PRIVATE_KEYS;if(!raw||raw.length>4096)throw new Error('UNCONFIGURED');return instance=createPayrollPrivateVault({activeKeyId:process.env.PAYROLL_PRIVATE_ACTIVE_KEY_ID,keys:JSON.parse(raw),fingerprintKey:process.env.PAYROLL_PRIVATE_FINGERPRINT_KEY});}catch{throw new Error('PAYROLL_PRIVATE_CONFIG_INVALID');}}
