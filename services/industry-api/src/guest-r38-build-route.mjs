/**
 * Runtime-only Fastify build health endpoint. No private data or credentials.
 * Advertised source SHA is a self-assertion, not a signed build attestation.
 */
export function registerR38BuildHealth(app,{env=process.env}={}){
  app.get('/api/industry/v1/health/build',async(_req,reply)=>{
    const commit=env.OSMANX_SOURCE_SHA||'';
    reply.header('Cache-Control','no-store');
    if(!/^[a-f0-9]{40}$/.test(commit)||
      env.NODE_ENV!=='production'||
      env.GUEST_WRITES_ENABLED==='true')
      return reply.code(503).send({status:'build_unavailable'});
    return {status:'build',commit,guestWritesEnabled:false,
      provenance:'operator-self-reported',
      signedBuildProvenanceVerified:false};
  });
}
