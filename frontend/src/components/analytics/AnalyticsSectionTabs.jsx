/*
 * The six analytics sections, as segmented tabs.
 *
 * The active tab is filled with the shell's navy AND carries a check icon, so it
 * is never distinguished by colour alone. `aria-current="page"` drives both the
 * styling and the announcement, so the two cannot disagree.
 *
 * The strip scrolls horizontally on a narrow screen rather than wrapping into a
 * ragged block — six short labels read better as one scrollable row — and the
 * scroll is confined to the strip, so the page itself never overflows sideways.
 */

export default function AnalyticsSectionTabs({ sections, active, loading, onSelect }) {
  return (
    <nav className="lms-analytics-surface mb-3" aria-label="Analytics section">
      <div className="lms-analytics-tabs" role="tablist">
        {sections.map((section) => {
          const isActive = active === section.key;
          return (
            <button
              key={section.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              // Both the style hook and the announcement, from one attribute.
              aria-current={isActive ? 'page' : undefined}
              className="lms-analytics-tab"
              onClick={() => onSelect(section.key)}
              // The active tab stays enabled while loading, so the strip does not
              // lose its selection to a disabled state mid-request.
              disabled={loading && !isActive}
            >
              <i className={`bi ${isActive ? 'bi-check-lg' : section.icon}`} aria-hidden="true" />
              {section.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
