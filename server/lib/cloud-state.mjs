// SQLite Durable Object 持久层。预算与检查点都先落盘，再返回成功。
// sql/transactionSync由所属对象提供；不持有其他对象或用户的全局状态。
export function createCloudState(storage) {
  const sql = storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK(id=1), day TEXT NOT NULL, calls INTEGER NOT NULL, reserved REAL NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, expires REAL NOT NULL, parts INTEGER NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS checkpoints_expiry ON checkpoints(expires)');
  sql.exec('CREATE TABLE IF NOT EXISTS checkpoint_parts (id TEXT NOT NULL, part INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(id,part))');
  const rows = (query,...args) => [...sql.exec(query,...args)];
  const remove = id => {sql.exec('DELETE FROM checkpoint_parts WHERE id=?',id);sql.exec('DELETE FROM checkpoints WHERE id=?',id);};
  const validId = id => /^(?:[a-f0-9]{64}_)?[a-f0-9-]{36}$/.test(id);
  return {
    reserve(kind,{limit,dailyAmount=null,rates={}},now=Date.now()) {
      if(!['model','search','map'].includes(kind)||!Number.isSafeInteger(limit)||limit<1)throw Error('上游额度配置无效');
      return storage.transactionSync(()=>{
        let ledger=rows('SELECT day,calls,reserved FROM budget WHERE id=1')[0];
        const day=new Date(now).toISOString().slice(0,10);
        if(ledger&&(!/^\d{4}-\d{2}-\d{2}$/.test(ledger.day)||!Number.isFinite(Date.parse(ledger.day))||new Date(ledger.day).toISOString().slice(0,10)!==ledger.day||!Number.isSafeInteger(ledger.calls)||ledger.calls<0||!Number.isFinite(ledger.reserved)||ledger.reserved<0))throw Error('上游额度账本损坏');
        if(!ledger||day>ledger.day)ledger={day,calls:0,reserved:0};
        const amount=dailyAmount===null?0:rates[kind];
        if(!Number.isFinite(amount)||amount<0||dailyAmount!==null&&(!Number.isFinite(dailyAmount)||dailyAmount<=0))throw Error('上游费用估算缺少费率');
        const reserved=Math.round((ledger.reserved+amount)*1e6)/1e6;
        if(ledger.calls>=limit||dailyAmount!==null&&reserved>dailyAmount)throw Object.assign(Error('今日上游调用额度已用尽'),{code:'UPSTREAM_BUDGET_EXCEEDED'});
        const next={day:ledger.day,calls:ledger.calls+1,reserved};
        sql.exec('INSERT INTO budget(id,day,calls,reserved) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,calls=excluded.calls,reserved=excluded.reserved',next.day,next.calls,next.reserved);
        return next;
      });
    },
    save(id,value) {
      if(!validId(id)||!Number.isFinite(value?.expires_at))throw Error('检查点格式无效');
      const content=JSON.stringify(value);
      if(new TextEncoder().encode(content).byteLength>8*1024*1024)throw Error('检查点超过保存上限');
      const parts=[];for(let i=0;i<content.length;i+=16384)parts.push(content.slice(i,i+16384));
      storage.transactionSync(()=>{
        remove(id);
        sql.exec('INSERT INTO checkpoints(id,expires,parts) VALUES(?,?,?)',id,value.expires_at,parts.length);
        parts.forEach((part,index)=>sql.exec('INSERT INTO checkpoint_parts(id,part,content) VALUES(?,?,?)',id,index,part));
      });
    },
    read(id,now=Date.now()) {
      if(!validId(id))return null;
      const saved=rows('SELECT expires,parts FROM checkpoints WHERE id=?',id)[0];
      if(!saved||saved.expires<=now)return null;
      const parts=rows('SELECT part,content FROM checkpoint_parts WHERE id=? ORDER BY part',id);
      if(parts.length!==saved.parts||parts.some((p,i)=>p.part!==i))return null;
      try{
        const value=JSON.parse(parts.map(p=>p.content).join(''));
        return value.schema_version===1&&value.expires_at===saved.expires&&['structure_ready','facts_checked','validated','committed'].includes(value.stage)&&typeof value.signature==='string'&&(value.stage!=='committed'||value.conversation&&typeof value.conversation==='object'&&!Array.isArray(value.conversation))?value:null;
      }catch{return null;}
    },
    prune(now=Date.now()) {
      storage.transactionSync(()=>{for(const {id}of rows('SELECT id FROM checkpoints WHERE expires<=? LIMIT 128',now))remove(id);});
    }
  };
}
