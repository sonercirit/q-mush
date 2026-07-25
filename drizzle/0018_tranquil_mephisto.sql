ALTER TABLE `agent_sessions` ADD `parent_execution_generation` integer;

-- Existing parent links predate generation capture. Their NULL generation keeps
-- them visible for audit while deliberately preventing delivery to a later
-- parent execution.
