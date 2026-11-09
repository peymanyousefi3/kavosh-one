import type { Connection } from '../core/database.ts';

const brokers={signature:'public.receive_signature_event(uuid,text,uuid,bigint,bigint,text,uuid,text,text,uuid,text,text,integer)',payment:'public.receive_payment_event(uuid,text,text,bigint,bigint,text,text,text,boolean,text,text,integer)'} as const;
export async function assertWebhookIngestRole(db:Connection,kind:keyof typeof brokers){
 const role='kavosh_'+kind+'_ingest',broker=brokers[kind];
 const result=await db.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname=$1 AND pg_has_role(current_user,b.oid,'member'))
 AND to_regprocedure($2) IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE (left(b.rolname,3)='pg_' OR left(b.rolname,7)='kavosh_' AND b.rolname<>$1 AND b.rolname<>current_user) AND pg_has_role(current_user,b.oid,'member'))
 AND NOT has_schema_privilege(current_user,'identity','usage') AND NOT has_schema_privilege(current_user,'auth_private','usage') AND NOT has_schema_privilege(current_user,'public','create')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='platform_private' AND has_schema_privilege(current_user,n.oid,'usage'))
 AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','identity','auth_private') AND pg_has_role(current_user,n.nspowner,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','identity','auth_private') AND pg_has_role(current_user,c.relowner,'member'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','identity','auth_private') AND c.relkind IN ('r','p','v','m','f')
 AND (has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') OR has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','identity','auth_private') AND p.prosecdef AND has_schema_privilege(current_user,n.oid,'USAGE') AND has_function_privilege(current_user,p.oid,'EXECUTE') AND p.oid<>to_regprocedure($2))
 AND NOT EXISTS(SELECT 1 FROM pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR e.rolcreaterole OR e.rolcreatedb OR e.rolreplication) AND pg_has_role(current_user,e.oid,'member')) AS safe FROM pg_roles r WHERE r.rolname=current_user`,[role,broker]);
 if(!result.rows[0]?.safe)throw new Error('UNSAFE_'+kind.toUpperCase()+'_INGEST_ROLE');
}
