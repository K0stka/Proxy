import React from 'react';
import { Tooltip } from '@mantine/core';
import { CircleHelp } from 'lucide-react';

export default function Help({ label, children }) {
  return <Tooltip label={children} multiline w={280} withArrow events={{ hover: true, focus: true, touch: true }}>
    <button type="button" className="help-button" aria-label={label}><CircleHelp size={16} /></button>
  </Tooltip>;
}
