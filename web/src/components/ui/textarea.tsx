import type * as React from 'react';
import { cn } from '@/lib/utils';

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'flex min-h-[80px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55 aria-[invalid=true]:border-danger-border aria-[invalid=true]:ring-danger-border/20',
        className,
      )}
      {...props}
    />
  );
}
