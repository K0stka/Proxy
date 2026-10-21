import React from 'react';
import { Modal as MantineModal, Stack } from '@mantine/core';
export default function Modal({ title, children, onClose, size }) {
  return (
    <MantineModal
      opened
      onClose={onClose}
      title={title}
      size={size}
      centered
      closeOnClickOutside
      padding="xl"
      radius="lg"
    >
      <Stack gap="lg">{children}</Stack>
    </MantineModal>
  );
}
