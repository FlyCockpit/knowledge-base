import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import type { ReactNode } from "react";

export function AuthScreen({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[80vh] items-center justify-center px-4">{children}</div>;
}

export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <AuthScreen>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </AuthScreen>
  );
}
