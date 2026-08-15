import Switch from './Switch';
import { capabilitiesFor, readinessFor } from './agentPlatformConfig';

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
  harness = null,
  onUpdatePlatform,
  onRepository,
  onWorkspace,
  compact = false,
}) {
  const readiness = Object.fromEntries(platforms.map((platform) => [
    platform.id,
    readinessFor(platform.id, platform.executable, harness, availableCommands),
  ]));
  const missingEnabled = platforms.filter((platform) => (
    platform.enabled && readiness[platform.id].tone === 'missing'
  ));
  const notReadyEnabled = platforms.filter((platform) => (
    platform.enabled && readiness[platform.id].tone === 'warn'
  ));
  const skills = harness?.skills || null;
  return (
    <div className={compact ? 'aruw-form aruw-form--compact' : 'aruw-form'}>
      {(skills || harness?.error) && (
        <p className={`aruw-skills${harness?.error || skills?.error ? ' aruw-skills--warn' : ''}`}>
          {harness?.error
            ? `Harness check failed on the machine: ${harness.error}`
            : skills?.error
              ? `Merv skills: ${skills.error}`
              : `Merv skills: ${Number(skills.count) || 0} installed on the machine${skills.digest ? ` · ${String(skills.digest).slice(0, 8)}` : ''}`}
        </p>
      )}
      <div className="aruw-agents">
        {platforms.map((platform) => {
          const ready = readiness[platform.id];
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
                  <small className="mono">
                    {platform.executable}
                    {ready.details.length > 0 && ` · ${ready.details.join(' · ')}`}
                  </small>
                </span>
                {ready.tag && (
                  <span
                    className={`aruw-tag aruw-tag--${ready.tone}`}
                    title={ready.problems.length ? ready.problems.join('\n') : undefined}
                  >
                    {ready.tag}
                  </span>
                )}
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
              {ready.problems.length > 0 && (
                <ul className="aruw-problems">
                  {ready.problems.map((problem) => <li key={problem}>{problem}</li>)}
                </ul>
              )}
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
      {notReadyEnabled.length > 0 && (
        <p className="aruw-warn">
          {notReadyEnabled.map((platform) => platform.name).join(', ')}
          {notReadyEnabled.length === 1 ? ' is' : ' are'} installed but not
          ready for Merv yet — see the problems listed above; the runner
          re-checks on every heartbeat.
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
