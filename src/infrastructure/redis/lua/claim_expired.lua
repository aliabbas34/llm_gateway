--[[
  Sweeper claim for one reservation (crash recovery). The gateway that reserved it never
  reconciled (crashed, or lost Redis at the end of a stream).

  Expired means expiresAt <= Redis TIME (ADR-0003). A claimed reservation is charged in FULL
  (no refund): conservative, and still never more than was reserved (FR5).

  Atomic HGET+HDEL: two sweepers on two instances can't both claim one reservation, and a late
  reconcile from a slow gateway becomes a no-op.

  KEYS[1] reservations (hash)
  ARGV[1] reservation id
  Returns {'claimed', reserved, input, studentId, requestId, ageMs}
        | {'not_expired', expiresAtMs} | {'already_settled'}
]]
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return { 'already_settled' }
end

local r = cjson.decode(raw)
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if tonumber(r.e) > now then
  return { 'not_expired', tostring(r.e) }
end

redis.call('HDEL', KEYS[1], ARGV[1])
return { 'claimed', r.r, r.i, r.s, r.q, now - tonumber(r.c) }
