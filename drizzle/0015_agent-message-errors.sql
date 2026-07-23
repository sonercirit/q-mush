UPDATE `agent_messages`
SET `role` = 'error'
WHERE `role` = 'system'
  AND `content` LIKE 'Session failed:%';
