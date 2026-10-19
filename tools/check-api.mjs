import crypto from "node:crypto";
const { ACCESS_KEY, SECRET_KEY } = process.env;
const HOST = "https://api-e.ecoflow.com";
async function call(path, params = {}) {
  const nonce = String(Math.floor(100000 + Math.random() * 900000));
  const timestamp = String(Date.now());
  const query = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  const auth = `accessKey=${ACCESS_KEY}&nonce=${nonce}&timestamp=${timestamp}`;
  const sign = crypto.createHmac("sha256", SECRET_KEY).update(query ? `${query}&${auth}` : auth).digest("hex");
  const res = await fetch(`${HOST}${path}${query ? "?" + query : ""}`, { headers: { accessKey: ACCESS_KEY, nonce, timestamp, sign } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const d = await call("/iot-open/sign/device/list");
console.log("LIST", d.status, JSON.stringify(d.body));
for (const dev of d.body.data || []) {
  const q = await call("/iot-open/sign/device/quota/all", { sn: dev.sn });
  const data = q.body.data || {};
  const soc = Object.keys(data).filter(k => /soc/i.test(k)).map(k => `${k}=${data[k]}`);
  console.log("QUOTA", dev.sn, dev.productName, dev.deviceName, "online:", dev.online, "| http", q.status, "code", q.body.code, q.body.message, "| keys:", Object.keys(data).length, "|", soc.join(", "));
}
