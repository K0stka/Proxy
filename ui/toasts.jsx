import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Notification } from '@mantine/core';
import { Check, CircleAlert } from 'lucide-react';

const ToastContext = createContext();

function Toast({ item, dismiss }) {
  useEffect(() => {
    const timer = setTimeout(() => dismiss(item.id), item.error ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [item, dismiss]);
  return (
    <Notification
      withBorder
      role={item.error ? 'alert' : 'status'}
      color={item.error ? 'red' : 'cyan'}
      icon={item.error ? <CircleAlert size={18} /> : <Check size={18} />}
      onClose={() => dismiss(item.id)}
      closeButtonProps={{ 'aria-label': 'Dismiss notification' }}
    >
      {item.message}
    </Notification>
  );
}

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const dismiss = useCallback(
    (id) => setItems((items) => items.filter((item) => item.id !== id)),
    [],
  );
  const notify = useCallback((message, error = false) => {
    if (!message) return;
    setItems((items) => {
      if (items.some((item) => item.message === message && item.error === error)) return items;
      return [...items.slice(-3), { id: crypto.randomUUID(), message, error }];
    });
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toast-stack" aria-label="Notifications">
        {items.map((item) => (
          <Toast key={item.id} item={item} dismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
