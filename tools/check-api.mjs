import crypto from "node:crypto";
const { ACCESS_KEY, SECRET_KEY } = process.env;
const HOST = process.env.API ?? "https://api-e.ecoflow.com"; // US: https://api.ecoflow.com
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
console.log("\nDEVICE_SNS (заготовка для секрету — замініть ключі на свої cmd):");
console.log(JSON.stringify(Object.fromEntries((d.body.data || []).map((x) => [String(x.deviceName || x.sn).toLowerCase().replace(/[^a-z0-9]+/g, "") || x.sn, x.sn]))));
console.log("");
console.log("LIST", d.status, JSON.stringify(d.body));
for (const dev of d.body.data || []) {
  const q = await call("/iot-open/sign/device/quota/all", { sn: dev.sn });
  const data = q.body.data || {};
  const soc = Object.keys(data).filter(k => /soc/i.test(k)).map(k => `${k}=${data[k]}`);
  const via = q.body.code === "0" ? "via: 'rest'" : q.body.code === "1006" ? "via: 'mqtt'" : "?";
  console.log(`→ ${dev.deviceName}: { sn: '${dev.sn}', ${via} }`);
  console.log("QUOTA", dev.sn, dev.productName, dev.deviceName, "online:", dev.online, "| http", q.status, "code", q.body.code, q.body.message, "| keys:", Object.keys(data).length, "|", soc.join(", "));
}
