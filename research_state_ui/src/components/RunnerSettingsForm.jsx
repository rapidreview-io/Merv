import Switch from './Switch';
import { capabilitiesFor, readinessFor } from './agentPlatformConfig';
import { agentStages } from './agentStages';

/**
 * RunnerSettingsForm — the one form for a paired runner's brain-held tuning.
 *
 * Lives in the machine drawer on the Auto-run page. It edits a draft
 * ({platforms, custom, workspace} from agentPlatformConfig.draftFromRunner)
 * and reports edits upward; saving is the caller's job. Custom command-adapter
 * agents configured on the machine are listed read-only: their executable
 * argv is machine-local by design.
 *
 * Under each enabled agent sits its setup ladder — installed → signed in →
 * Merv skills → test call — with one state per rung, so the owner sees what
 * is being checked and what has held so far. Test asks the machine for one
 * real call through that harness (``onTest``); the runner reports the outcome
 * on its next heartbeat.
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
  onTest = null,
  testing = '',
  now = Date.now(),
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
  // Agents the machine does not have and the owner has not enabled are one
  // faint line, not a card each: they cannot run here until installed, and
  // the runner re-probes on every heartbeat, so they surface by themselves.
  const shown = platforms.filter((platform) => platform.enabled || readiness[platform.id].tone !== 'missing');
  const absent = platforms.filter((platform) => !platform.enabled && readiness[platform.id].tone === 'missing');
  return (
    <div className="arf">
      {(skills || harness?.error) && (
        <p className={`arf-skills${harness?.error || skills?.error ? ' arf-skills--warn' : ''}`}>
          {harness?.error
            ? `Harness check failed on the machine: ${harness.error}`
            : skills?.error
              ? `Merv skills: ${skills.error}`
              : `Merv skills: ${Number(skills.count) || 0} installed on the machine${skills.digest ? ` · ${String(skills.digest).slice(0, 8)}` : ''}`}
        </p>
      )}
      <div className="arf-agents">
        {shown.map((platform) => {
          const ready = readiness[platform.id];
          const capabilities = capabilitiesFor(platform.id);
          const errors = validation?.platforms?.[platform.id] || {};
          return (
            <div className="arf-agent" key={platform.id}>
              <div className="arf-agent-head">
                <Switch
                  checked={platform.enabled}
                  onChange={(value) => onUpdatePlatform(platform.id, { enabled: value })}
                  label={`Enable ${platform.name}`}
                />
                <span className="arf-agent-name">
                  <strong>{platform.name}</strong>
                  <small className="mono">
                    {platform.executable}
                    {ready.details.length > 0 && ` · ${ready.details.join(' · ')}`}
                  </small>
                </span>
                {ready.tag && (
                  <span
                    className={`arf-tag arf-tag--${ready.tone}`}
                    title={ready.problems.length ? ready.problems.join('\n') : undefined}
                  >
                    {ready.tag}
                  </span>
                )}
                <label className="arf-par">
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
              {ready.problems.length > 0 && !platform.enabled && (
                <ul className="arf-problems">
                  {ready.problems.map((problem) => <li key={problem}>{problem}</li>)}
                </ul>
              )}
              {platform.enabled && (
                <AgentStages
                  stages={agentStages({
                    entry: harness?.platforms?.[platform.id] || null,
                    readiness: ready,
                    enabled: platform.enabled,
                    now,
                  })}
                  canTest={Boolean(onTest) && ready.tone !== 'missing'}
                  testing={testing === platform.id}
                  onTest={() => onTest?.(platform.id)}
                />
              )}
              {platform.enabled && (capabilities.model || capabilities.effort) && (
                <div className="arf-agent-tuning">
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
                        list={`arf-effort-${platform.id}`}
                        onChange={(e) => onUpdatePlatform(platform.id, { effort: e.target.value })}
                      />
                      <datalist id={`arf-effort-${platform.id}`}>
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
        {absent.length > 0 && (
          <p className="arf-absent">
            Not on this machine: {absent.map((platform) => platform.name).join(', ')}.
          </p>
        )}
        {custom.map((agent) => (
          <div className="arf-agent arf-agent--readonly" key={`custom-${agent.id}`}>
            <div className="arf-agent-head">
              <span className={`arm-dot arm-dot--${agent.enabled ? 'running' : 'off'}`} aria-hidden="true" />
              <span className="arf-agent-name">
                <strong>{agent.name}</strong>
                <small className="mono">custom {agent.harness} agent · ×{agent.parallelism} · configured on the machine</small>
              </span>
            </div>
          </div>
        ))}
      </div>
      {missingEnabled.length > 0 && (
        <p className="arf-warn">
          {missingEnabled.map((platform) => platform.name).join(', ')}
          {missingEnabled.length === 1 ? ' is' : ' are'} not installed on
          the runner machine.
        </p>
      )}
      {notReadyEnabled.length > 0 && (
        <p className="arf-warn">
          {notReadyEnabled.map((platform) => platform.name).join(', ')}
          {notReadyEnabled.length === 1 ? ' is' : ' are'} installed but not
          ready for Merv yet — see the problems listed above; the runner
          re-checks on every heartbeat.
        </p>
      )}

      <div className="arf-workspace">
        <p className="arf-help">
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

const STAGE_GLYPH = { ok: '●', running: '●', fail: '●', unknown: '○', pending: '○' };

/**
 * The ladder: one line per stage, the state in the glyph's colour, the fact
 * or the fix in words. Test sits on the last rung.
 */
function AgentStages({ stages, canTest, testing, onTest }) {
  return (
    <ol className="arf-stages" aria-label="Setup stages">
      {stages.map((stage) => (
        <li key={stage.key} className={`arf-stage arf-stage--${stage.state}`}>
          <span className="arf-stage-glyph" aria-hidden="true">{STAGE_GLYPH[stage.state] || '○'}</span>
          <span className="arf-stage-label">{stage.label}</span>
          <span className="arf-stage-detail">
            {stage.detail}
            {stage.hint && <span className="arf-stage-hint"> — {stage.hint}</span>}
          </span>
          {stage.key === 'smoke' && canTest && (
            <button
              type="button"
              className="btn btn--ghost btn--xs arf-stage-test"
              disabled={testing || stage.state === 'running'}
              onClick={onTest}
            >
              {testing ? 'Asking…' : stage.state === 'running' ? 'Running…' : stage.state === 'unknown' ? 'Test' : 'Test again'}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
