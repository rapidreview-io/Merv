import Switch from './Switch';
import { capabilitiesFor } from './agentPlatformConfig';

/**
 * RunnerSettingsForm — the one form for a paired runner's brain-held tuning.
 *
 * Used by the setup wizard and by the Runner settings drawer so the fields
 * exist once. It edits a draft ({platforms, custom, workspace} from
 * agentPlatformConfig.draftFromRunner) and reports edits upward; saving is
 * the caller's job. Custom command-adapter agents configured on the machine
 * are listed read-only: their executable argv is machine-local by design.
 */
export default function RunnerSettingsForm({
  platforms,
  custom = [],
  workspace,
  validation,
  availableCommands = null,
  onUpdatePlatform,
  onRepository,
  onWorkspace,
  compact = false,
}) {
  const missingEnabled = platforms.filter((platform) => (
    platform.enabled && availableCommands && availableCommands[platform.executable] === false
  ));
  return (
    <div className={compact ? 'aruw-form aruw-form--compact' : 'aruw-form'}>
      <div className="aruw-agents">
        {platforms.map((platform) => {
          const found = availableCommands ? availableCommands[platform.executable] : undefined;
          const capabilities = capabilitiesFor(platform.id);
          const errors = validation?.platforms?.[platform.id] || {};
          return (
            <div className="aruw-agent" key={platform.id}>
              <div className="aruw-agent-head">
                <Switch
                  checked={platform.enabled}
                  onChange={(value) => onUpdatePlatform(platform.id, { enabled: value })}
                  label={`Enable ${platform.name}`}
                />
                <span className="aruw-agent-name">
                  <strong>{platform.name}</strong>
                  <small className="mono">{platform.executable}</small>
                </span>
                {found === true && <span className="aruw-tag aruw-tag--ok">installed</span>}
                {found === false && <span className="aruw-tag aruw-tag--missing">not found</span>}
                <label className="aruw-par">
                  <span aria-hidden="true">×</span>
                  <input
                    type="number"
                    min="1"
                    max="32"
                    aria-label={`${platform.name} parallel experiments`}
                    value={platform.parallelism}
                    onChange={(e) => onUpdatePlatform(platform.id, { parallelism: e.target.value })}
                  />
                </label>
              </div>
              {errors.parallelism && <small className="field-error">{errors.parallelism}</small>}
              {platform.enabled && (capabilities.model || capabilities.effort) && (
                <div className="aruw-agent-tuning">
                  {capabilities.model && (
                    <label>
                      <span>Model</span>
                      <input
                        value={platform.model}
                        placeholder="Platform default"
                        spellCheck={false}
                        onChange={(e) => onUpdatePlatform(platform.id, { model: e.target.value })}
                      />
                    </label>
                  )}
                  {capabilities.effort && (
                    <label>
                      <span>Effort</span>
                      <input
                        value={platform.effort}
                        placeholder="Platform default"
                        spellCheck={false}
                        list={`aruw-effort-${platform.id}`}
                        onChange={(e) => onUpdatePlatform(platform.id, { effort: e.target.value })}
                      />
                      <datalist id={`aruw-effort-${platform.id}`}>
                        <option value="low" />
                        <option value="medium" />
                        <option value="high" />
                        <option value="xhigh" />
                      </datalist>
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {custom.map((agent) => (
          <div className="aruw-agent aruw-agent--readonly" key={`custom-${agent.id}`}>
            <div className="aruw-agent-head">
              <span className={`aru-live-dot aru-live-dot--${agent.enabled ? 'live' : 'off'}`} aria-hidden="true" />
              <span className="aruw-agent-name">
                <strong>{agent.name}</strong>
                <small className="mono">custom {agent.harness} agent · ×{agent.parallelism} · configured on the machine</small>
              </span>
            </div>
          </div>
        ))}
      </div>
      {missingEnabled.length > 0 && (
        <p className="aruw-warn">
          {missingEnabled.map((platform) => platform.name).join(', ')}
          {missingEnabled.length === 1 ? ' is' : ' are'} not installed on
          the runner machine.
        </p>
      )}

      <div className="aruw-workspace">
        <p className="sbxpw-help">
          Paths on the runner machine. Each job gets its own Git worktree.
        </p>
        <label>
          <span>Repository</span>
          <input
            className="mono"
            value={workspace.repository}
            placeholder="/absolute/path/to/repository"
            spellCheck={false}
            onChange={(e) => onRepository(e.target.value)}
          />
          {validation?.workspace?.repository && (
            <small className="field-error">{validation.workspace.repository}</small>
          )}
        </label>
        <label>
          <span>Worktree root</span>
          <input
            className="mono"
            value={workspace.root}
            placeholder="/absolute/path/to/worktrees"
            spellCheck={false}
            onChange={(e) => onWorkspace({ root: e.target.value })}
          />
          {validation?.workspace?.root && (
            <small className="field-error">{validation.workspace.root}</small>
          )}
        </label>
        <label>
          <span>Base ref</span>
          <input
            className="mono"
            value={workspace.base_ref}
            spellCheck={false}
            onChange={(e) => onWorkspace({ base_ref: e.target.value })}
          />
          {validation?.workspace?.base_ref && (
            <small className="field-error">{validation.workspace.base_ref}</small>
          )}
        </label>
      </div>
    </div>
  );
}
