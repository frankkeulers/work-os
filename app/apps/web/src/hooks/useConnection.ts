import { createContext, useContext } from 'react';
import type { HealthView } from '@work-os/shared';

// The connection to the server, as Root last heard it. While it is reconnecting the page stays up,
// with what Frank was doing, but nothing that changes state can be sent.

export const ConnectionContext = createContext<HealthView['connection']>('up');

export const useOnline = () => useContext(ConnectionContext) === 'up';
