export function postgresOptions(connectionString: string | undefined, env: { NODE_ENV?: string; DATABASE_SSL_MODE?: string } = process.env) {
  if (!connectionString) throw new Error('DATABASE_NOT_CONFIGURED');
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('INVALID_DATABASE_URL');
  if (['ssl','sslmode','sslcert','sslkey','sslrootcert'].some(key => url.searchParams.has(key))) throw new Error('USE_DATABASE_SSL_MODE');
  const disabled = env.DATABASE_SSL_MODE === 'disable';
  if (env.NODE_ENV === 'production' && disabled) throw new Error('DATABASE_TLS_REQUIRED');
  return { connectionString, ssl: disabled ? false as const : { rejectUnauthorized: true } };
}
