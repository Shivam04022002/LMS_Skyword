import { useEffect, useState } from 'react';

/**
 * Delays propagating a rapidly changing value, so a search box issues one
 * request after typing settles rather than one per keystroke.
 */
export function useDebouncedValue(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

export default useDebouncedValue;
