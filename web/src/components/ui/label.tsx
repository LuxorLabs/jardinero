import * as LabelPrimitive from '@radix-ui/react-label';
import type * as React from 'react';
import { cn } from '@/lib/utils';

export function Label({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn(
        'grid gap-1.5 font-[650] text-[13px] text-slate leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-55',
        className,
      )}
      {...props}
    />
  );
}
