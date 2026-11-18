// 构建由 server/build-cloudflare.mjs 生成 cf Build Output；不包含任何密钥。
export default {
  accountId: 'ff33bebdc76cb049a1c157545d29ff8f',
  worker: {
    name: 'mixtouring',
    compatibilityDate: '2026-11-12',
    compatibilityFlags: ['nodejs_compat','global_fetch_strictly_public'],
    entrypoint: './server/cloudflare/worker.mjs',
    workersDev: true,
    domains: ['mixtouring.app'],
    previewUrls: false,
    assets: {htmlHandling:'none',runWorkerFirst:true},
    observability: {enabled:true,redactQueryString:true,logs:{enabled:true},traces:{enabled:true,headSamplingRate:0.1}},
    env: {
      ASSETS:{type:'assets'},
      TRAVELERS:{type:'durable-object',worker:'mixtouring',exportName:'TravelerAgent'},
      USAGE:{type:'durable-object',worker:'mixtouring',exportName:'UsageCoordinator'},
      MT_RUNTIME:{type:'text',value:'cloudflare'},
      MT_COMPOSE_PROVIDER:{type:'text',value:'deepseek'},
      MT_ITINERARY_REVIEW:{type:'text',value:'final'},
      MT_PUBLIC:{type:'text',value:'1'},
      MT_ACCOUNT_AUTH:{type:'text',value:'1'},
      MT_PUBLIC_ORIGIN:{type:'text',value:'https://mixtouring.app'},
      MT_MAX_CONCURRENT:{type:'text',value:'4'},
      MT_API_PER_MINUTE:{type:'text',value:'20'},
      MT_DAILY_UPSTREAM_LIMIT:{type:'text',value:'200'}
    },
    exports: {
      OpenAITransport:{type:'durable-object',state:'deleted'},
      TravelerAgent:{type:'durable-object',storage:'sqlite'},
      UsageCoordinator:{type:'durable-object',storage:'sqlite'}
    }
  }
};
