// mode 可填 https 或 cloud；选择其一，未选择时不发起请求。
// https：baseUrl 填真实 HTTPS 接口域名的 origin，不带 /api/v1 路径。
// cloud：填写实际微信云托管环境 ID 和服务名，服务须提供相同 /api/v1 接口。
// 环境 ID、服务名是客户端调用标识；AppSecret、密钥绝不能放在这里。
// 不把云托管默认公网测试域名用作生产 baseUrl。
module.exports = { mode: '', baseUrl: '', cloudEnv: '', serviceName: '', pollMs: 5000, timeoutMs: 10000 };
