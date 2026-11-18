import {randomBytes,createHash} from 'node:crypto';
const username=process.argv[2];
if(!/^[a-zA-Z0-9_-]{1,64}$/.test(username || ''))throw Error('用法: node server/create-invite.mjs <username>');
const password=randomBytes(32).toString('base64url');
console.log(JSON.stringify({username,password,access_users:{[username]:createHash('sha256').update(password).digest('hex')}},null,2));
