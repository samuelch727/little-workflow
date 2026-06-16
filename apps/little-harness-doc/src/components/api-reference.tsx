import type { ReactNode } from 'react';

type ApiFieldProps = {
  name: string;
  type: string;
  children: ReactNode;
};

type ApiTypeBlockProps = {
  name: string;
  children: ReactNode;
};

export function ApiParameters({ children }: { children: ReactNode }) {
  return (
    <div className="not-prose my-6 border-y border-fd-border" data-api-parameters>
      {children}
    </div>
  );
}

export function ApiField({ name, type, children }: ApiFieldProps) {
  return (
    <div className="border-t border-fd-border first:border-t-0 py-5" data-api-field>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[15px] leading-7">
        <span className="font-semibold text-fd-foreground">{name}:</span>
        <span className="break-words text-fd-muted-foreground">{type}</span>
      </div>
      <div className="mt-2 text-[15px] leading-7 text-fd-muted-foreground [&_code]:rounded [&_code]:bg-fd-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-fd-foreground [&_p]:my-0 [&_p+p]:mt-3 [&_ul]:my-3 [&_ul]:pl-5 [&_li]:my-1">
        {children}
      </div>
    </div>
  );
}

export function ApiTypeBlock({ name, children }: ApiTypeBlockProps) {
  return (
    <div
      className="relative my-6 rounded-lg border border-fd-border bg-fd-background"
      data-api-type-block
    >
      <div className="absolute right-4 top-0 -translate-y-1/2 rounded-md bg-fd-muted px-3 py-1 font-mono text-sm text-fd-muted-foreground">
        {name}
      </div>
      <div className="divide-y divide-fd-border px-5 py-2">{children}</div>
    </div>
  );
}
