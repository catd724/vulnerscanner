'use client';

/**
 * terminal.ai - the address.
 *
 * `user@host:port` is the one string this whole app is organised around, so it
 * gets a single component and one typographic treatment everywhere it appears:
 * sidebar rows, pane headers, recent cards, tunnel routes.
 *
 * The parts are weighted by how much they matter when you are scanning a list.
 * The host is what you are looking for, so it is the brightest; the user and
 * the port are context, so they recede. A default port is dropped entirely -
 * :22 on every row is noise that pushes the useful part off the end.
 */

export function Address({ user, host, port, defaultPort = 22, className = '' }) {
  return (
    <span className={`addr ${className}`}>
      {user && (
        <>
          <span className="addr-user">{user}</span>
          <span className="addr-sep">@</span>
        </>
      )}
      <span className="addr-host">{host}</span>
      {port && Number(port) !== defaultPort && (
        <>
          <span className="addr-sep">:</span>
          <span className="addr-port">{port}</span>
        </>
      )}
    </span>
  );
}

/**
 * Status marker. Hollow when idle, filled and lit when a session is live -
 * readable at a glance down a long list without relying on colour alone.
 */
export function StatusDot({ status = 'idle', title }) {
  return <span className="status-marker" data-status={status} title={title} aria-hidden="true" />;
}

export default Address;
