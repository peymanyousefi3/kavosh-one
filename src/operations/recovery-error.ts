export class RecoveryError extends Error {
 constructor(readonly code:string){super(code);this.name='RecoveryError';}
}
