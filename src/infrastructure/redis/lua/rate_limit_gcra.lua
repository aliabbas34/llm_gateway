--[[
  GCRA (generic cell rate algorithm) rate limiter: "limit requests per period", with bursts of up
  to `limit` allowed, in one key, atomically.

  State: the "theoretical arrival time" (TAT) of the next request, in ms. Each allowed request
  pushes TAT forward by one emission interval (period / limit). A request is allowed if, after
  adding it, TAT is no more than one period ahead of now.

  KEYS[1]  limiter key
  ARGV[1]  limit (requests per period)
  ARGV[2]  period in ms
  Returns  { allowed (1|0), retry_after_ms }

  Time comes from Redis TIME, so every gateway instance shares one clock (ADR-0003).
]]
local limit = tonumber(ARGV[1])
local period = tonumber(ARGV[2])
local emission = period / limit

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local tat = tonumber(redis.call('GET', KEYS[1]))
if tat == nil or tat < now then tat = now end

local new_tat = tat + emission
local allow_at = new_tat - period
if allow_at > now then
  return { 0, math.ceil(allow_at - now) }
end

-- At least 1 ms: with very high limits the emission interval is below double precision at epoch-ms
-- magnitudes, new_tat - now rounds to 0, and SET PX 0 is an error (found by the load test).
redis.call('SET', KEYS[1], string.format('%.3f', new_tat), 'PX', math.max(1, math.ceil(new_tat - now)))
return { 1, 0 }
