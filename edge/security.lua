-- CrowdSec owns detection rules; this adapter applies the proxy's per-service policy.
local json = require "cjson.safe"
local http = require "resty.http"
if string.sub(ngx.var.server_addr or "", 1, 5) == "unix:" or ngx.is_subrequest or ngx.req.is_internal() or ngx.ctx.security_checked then return end
if ngx.var.security_mode == "off" then return end
ngx.ctx.security_checked = true
local client = http.new()
client:set_timeout(2000)
local connected = client:connect({scheme = "http", host = "unix:/tmp/proxy-security.sock"})
local response
if connected then
  response = client:request({path = "/check", method = "POST",
    body = json.encode({ip = ngx.var.remote_addr, service = ngx.var.monitor_service}),
    headers = { ["Host"] = "edge.local", ["Content-Type"] = "application/json" }
  })
  if response then response.body = response:read_body() end
  client:set_keepalive()
end
local p = response and response.status == 200 and json.decode(response.body)
if not p then
  ngx.var.security_inspected = "true"
  ngx.var.security_engine = "Availability"
  ngx.var.security_reason = "Security policy unavailable"
  -- The configured failure behavior is also rendered into NGINX for local IPC outages.
  if ngx.var.security_failure == "deny" and ngx.var.security_mode == "block" then
    ngx.var.security_action = "Blocked"
    return ngx.exit(503)
  end
  ngx.var.security_action = "Error"
  return
end
if p.mode == "off" then return end
ngx.var.security_inspected = "true"
ngx.var.security_action = p.action
ngx.var.security_engine = p.engine
ngx.var.security_reason = p.reason
local failed = p.error ~= nil
if p.action == "Blocked" then return ngx.exit(403) end
-- Management APIs validate authenticated, CSRF-protected requests in the controller;
-- avoid CRS false positives on legitimate settings payloads such as bot tokens.
local managementAPI = ngx.var.monitor_service == "management"
  and string.sub(ngx.var.uri or "", 1, 5) == "/api/"
  and string.sub(ngx.var.uri or "", 1, 10) ~= "/api/auth/"
if p.waf and not managementAPI then
  local cs = require "crowdsec"
  if not cs.proxy_initialized then cs.proxy_initialized = cs.init('/security-ipc/bouncer.conf', 'proxy-crowdsec/1') end
  local called, ok, remediation, status, extra, err = pcall(cs.AppSecCheck, ngx.var.remote_addr)
  if not called or err then failed = true
  elseif not ok then
    ngx.var.security_engine = "WAF"
    ngx.var.security_reason = "CrowdSec application security rule"
    ngx.var.security_action = p.mode == "block" and "Blocked" or "Detected"
    if p.mode == "block" then return ngx.exit(403) end
  end
end
if failed then
  ngx.var.security_engine = "Availability"
  ngx.var.security_reason = "CrowdSec inspection unavailable"
  ngx.var.security_action = "Error"
  if p.mode == "block" and p.failure == "deny" then
    ngx.var.security_action = "Blocked"
    return ngx.exit(503)
  end
end
