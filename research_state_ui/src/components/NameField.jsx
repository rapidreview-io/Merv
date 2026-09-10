import { NAME_RE } from '../utils/experiment';

/**
 * The name field both creation forms carry. The name becomes a folder on
 * disk, so it shows the folder it will make as you type and says the rule in
 * the same words when the rule doesn't hold.
 *
 * @param {string} folder  the directory the record lands in ("experiments")
 * @param {string} unique  how far the uniqueness requirement reaches
 */
export default function NameField({ value, onChange, placeholder, folder, unique }) {
  const ok = NAME_RE.test(value);
  return (
    <div className="form-row">
      <label className="label">Name</label>
      <input
        className="input"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={48}
        autoFocus
        required
      />
      <div className="form-hint">
        Becomes the {folder.replace(/s$/, '')} folder <code>{folder}/{ok ? value : '<name>'}/</code> —
        letters, digits, dots, dashes, underscores; {unique}.
      </div>
      {value && !ok && (
        <div className="error-message">
          Folder-safe names start with a letter or digit and use only letters,
          digits, '.', '_' and '-'.
        </div>
      )}
    </div>
  );
}
