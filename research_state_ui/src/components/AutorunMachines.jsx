import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import AutorunPairing, { CommandLine, RUNNER_COMMAND } from './AutorunPairing';
import RunnerSettingsForm from './RunnerSettingsForm';
import { runnerPresentation } from './runnerPresentation';
import { isLiveSession } from './agentSessionPresentation';
import {
  draftFromRunner,
  draftSignature,
  settingsFromDraft,
  validateDraft,
  workspaceWithRepository,
} from './agentPlatformConfig';
import { fmtAgo } from '../utils/format';

/**
 * AutorunMachines — the machines console: paired runners and their tuning.
 *
 * One row per runner the brain has heard from; the twist opens the drawer
 * that holds everything about that machine — which agents run, with what
 * model and effort, where the worktrees go, and whether each agent is ready
 * for Merv on that box. Rails carry attention: amber when dispatch is on but
 * the machine is not answering, red when it rejected its settings. The foot
 * row pairs another machine in place.
 */

const DOT_BY_TONE = { live: 'running', warning: 'stale', error: 'off', off: 'off' };
// Runners from this build understand the one-shot probe (Test); an older one
// would reject the whole settings document, so Test is not offered to it.
const PROBE_MIN_RUNNER_VERSION = '2026.08.16';
const rank = (view) => (view.live ? 0 : view.tone === 'warning' ? 1 : 2);

export default function AutorunMachines({ projectId, runners, sessions, dispatch, now, onRunner, onRefresh }) {
  const [expanded, setExpanded] = useState('');
  const [pairing, setPairing] = useState(false);

  const rows = useMemo(() => (
    (runners || [])
      .map((runner) => ({ runner, view: runnerPresentation(runner, now) }))
      .sort((a, b) => {
        const diff = rank(a.view) - rank(b.view);
        if (diff !== 0) return diff;
        return String(b.runner.last_seen_at || '').localeCompare(String(a.runner.last_seen_at || ''));
      })
  ), [runners, now]);

  const usedByMachine = useMemo(() => {
    const used = {};
    for (const session of sessions || []) {
      if (!isLiveSession(session)) continue;
      const host = session?.agent_setup?.machine || '';
      used[host] = (used[host] || 0) + 1;
    }
    return used;
  }, [sessions]);

  return (
    <div className="arm-scroll">
      <div className="arm" role="table" aria-label="Machines">
        <div className="arm-head con-head" role="row">
          <span aria-hidden="true" />
          <span className="th th--con">Status</span>
          <span className="th th--con">Machine</span>
          <span className="th th--con">Agents</span>
          <span className="th th--con th--r">Slots</span>
          <span className="th th--con th--r">Last seen</span>
        </div>
        {rows.map(({ runner, view }) => (
          <MachineRow
            key={runner.runner_ref}
            projectId={projectId}
            runner={runner}
            view={view}
            used={usedByMachine[view.machineName] || 0}
            dispatch={dispatch}
            open={expanded === runner.runner_ref}
            onToggle={() => setExpanded(expanded === runner.runner_ref ? '' : runner.runner_ref)}
            onRunner={onRunner}
            now={now}
          />
        ))}
        <div className={`arm-rowgroup arm-rowgroup--foot${pairing ? ' open' : ''}`}>
          <div
            className="arm-rowhead arm-foot"
            role="button"
            tabIndex={0}
            aria-expanded={pairing}
            onClick={() => setPairing((current) => !current)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPairing((c) => !c); } }}
          >
            <span className={`twist${pairing ? ' open' : ''}`} aria-hidden="true">▸</span>
            <span className="arm-foot-label">Pair a machine</span>
          </div>
          {pairing && (
            <div className="arm-drawer">
              <AutorunPairing
                projectId={projectId}
                runners={runners}
                onRefresh={onRefresh}
                onPaired={(runner) => { setPairing(false); if (runner?.runner_ref) setExpanded(runner.runner_ref); }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MachineRow({ projectId, runner, view, used, dispatch, open, onToggle, onRunner, now }) {
  const enabled = (runner.platforms || []).filter((item) => item.enabled !== false).map((item) => item.name);
  const capacity = Number(runner.capacity) || 0;
  const rail = view.settingsTone === 'error'
    ? ' arm-rowgroup--error'
    : (dispatch === true && !view.live ? ' arm-rowgroup--attention' : '');
  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };
  return (
    <div className={`arm-rowgroup${open ? ' open' : ''}${rail}`}>
      <div className="arm-rowhead" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={onKey}>
        <div className="arm-row" role="row">
          <span className={`twist${open ? ' open' : ''}`} aria-hidden="true">▸</span>
          <span className="arm-status">
            <span className={`arm-dot arm-dot--${DOT_BY_TONE[view.tone] || 'off'}`} />
            <span className="arm-status-label">{view.state}</span>
          </span>
          <span className="arm-machine">
            <span className="arm-machine-name">{view.machineName}</span>
            {view.machineDetails && <span className="arm-machine-sub">{view.machineDetails}</span>}
          </span>
          <span className={`arm-agents${enabled.length ? '' : ' arm-agents--none'}`} title={enabled.join(', ')}>
            {enabled.length ? enabled.join(', ') : 'none enabled'}
            {view.settings && <span className={`arm-settings arm-settings--${view.settingsTone}`}> · {view.settings}</span>}
          </span>
          <span className="arm-num">{view.live ? `${used}/${capacity}` : '—'}</span>
          <span className="arm-num">{view.ageMs == null ? '—' : fmtAgo(view.ageMs)}</span>
        </div>
      </div>
      {open && (
        <div className="arm-drawer">
          <MachineDrawer projectId={projectId} runner={runner} view={view} onRunner={onRunner} now={now} />
        </div>
      )}
    </div>
  );
}

/**
 * The tuning drawer: a draft of the brain-held settings for one machine,
 * seeded from the runner row and re-seeded when the machine reports a newer
 * view while the form is clean. Saving hands the settings to the brain; the
 * runner applies them on its next poll and reports back.
 */
function MachineDrawer({ projectId, runner, view, onRunner, now }) {
  const [draft, setDraft] = useState(() => draftFromRunner(runner));
  const [testing, setTesting] = useState('');
  const [testError, setTestError] = useState('');
  const [probeNonce, setProbeNonce] = useState('');
  const [base, setBase] = useState(() => {
    const seeded = draftFromRunner(runner);
    return draftSignature(seeded.platforms, seeded.workspace);
  });
  const [save, setSave] = useState({ busy: false, error: '', savedVersion: 0, applied: false });

  const signature = draftSignature(draft.platforms, draft.workspace);
  const dirty = signature !== base;

  useEffect(() => {
    if (dirty) return;
    const seeded = draftFromRunner(runner);
    setDraft(seeded);
    setBase(draftSignature(seeded.platforms, seeded.workspace));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.desired_version, runner.last_seen_at]);

  useEffect(() => {
    if (save.savedVersion && !save.applied && Number(runner.applied_version || 0) >= save.savedVersion) {
      setSave((current) => ({ ...current, applied: true }));
    }
  }, [runner.applied_version, save.savedVersion, save.applied]);

  const validation = useMemo(() => validateDraft(draft.platforms, draft.workspace), [draft]);

  function updatePlatform(id, patch) {
    setDraft((current) => ({
      ...current,
      platforms: current.platforms.map((platform) => (platform.id === id ? { ...platform, ...patch } : platform)),
    }));
  }
  function updateRepository(repository) {
    setDraft((current) => ({ ...current, workspace: workspaceWithRepository(current.workspace, repository) }));
  }
  function updateWorkspace(patch) {
    setDraft((current) => ({ ...current, workspace: { ...current.workspace, ...patch } }));
  }

  async function saveSettings() {
    if (!validation.valid) {
      setSave((current) => ({ ...current, error: 'Fix the highlighted fields first.' }));
      return;
    }
    setSave({ busy: true, error: '', savedVersion: 0, applied: false });
    try {
      const response = await api.putRunnerSettings(
        projectId,
        runner.runner_ref,
        settingsFromDraft(draft.platforms, draft.workspace),
      );
      const row = response?.runner || null;
      setBase(signature);
      setSave({ busy: false, error: '', savedVersion: Number(row?.desired_version || 0), applied: false });
      if (row) onRunner?.(row);
    } catch (err) {
      setSave({ busy: false, error: err?.message || 'Could not save.', savedVersion: 0, applied: false });
    }
  }

  // Test = one probe in the desired settings; the runner runs it once per
  // nonce and reports the outcome on its next heartbeat (the stage shows
  // "queued" / "running" / the result as it arrives).
  async function testAgent(platformId) {
    setTesting(platformId);
    setTestError('');
    try {
      const nonce = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const response = await api.putRunnerSettings(projectId, runner.runner_ref, {
        probe: { platform: platformId, nonce },
      });
      setProbeNonce(nonce);
      if (response?.runner) onRunner?.(response.runner);
    } catch (err) {
      setTestError(err?.message || 'Could not ask the machine to test.');
    } finally {
      setTesting('');
    }
  }

  const probePending = Boolean(probeNonce)
    && runner?.desired_settings?.probe?.nonce === probeNonce
    && Number(runner?.desired_version || 0) > Number(runner?.applied_version || 0);
  const note = (() => {
    if (testError) return testError;
    if (save.busy) return 'Saving…';
    if (dirty) return 'Unsaved changes.';
    if (probePending) return `Test requested — ${view.machineName} picks it up on its next poll.`;
    if (view.settings) return view.settings;
    if (save.savedVersion && save.applied) return `Applied on ${view.machineName}.`;
    if (save.savedVersion) return `Saved — ${view.machineName} applies it on its next poll.`;
    return '';
  })();

  return (
    <div className="arf-drawer">
      {!view.live && (
        <div className="arf-start">
          <span>{view.state === 'Stale' ? 'Not answering' : 'Offline'} — start it on {view.machineName}:</span>
          <CommandLine command={RUNNER_COMMAND} />
        </div>
      )}
      <RunnerSettingsForm
        platforms={draft.platforms}
        custom={draft.custom}
        workspace={draft.workspace}
        validation={validation}
        availableCommands={runner.inventory?.available_commands || null}
        harness={runner.inventory?.harness || null}
        onUpdatePlatform={updatePlatform}
        onRepository={updateRepository}
        onWorkspace={updateWorkspace}
        onTest={view.live && String(runner.inventory?.runner_version || '') >= PROBE_MIN_RUNNER_VERSION ? testAgent : null}
        testing={testing}
        now={now}
      />
      {!validation.valid && (
        <ul className="arf-validation" role="alert">
          {[...new Set(validation.messages)].map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}
      <div className="arf-apply">
        <span className={`arf-note${save.error || testError ? ' arf-note--error' : ''}`} role="status">{save.error || note}</span>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={save.busy || !dirty || !validation.valid}
          onClick={saveSettings}
        >
          {save.busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
