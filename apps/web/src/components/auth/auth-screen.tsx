import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import type { ReactNode } from "react";

/**
 * From `sm` up the auth card is centred in the page. On phones it starts just
 * under the header instead: centring in `80vh` pushed it down by up to a fifth
 * of the screen, and with the first-visit cookie banner showing, the card's
 * last line (the login page's sign-up link) ended behind the banner at 320×568.
 */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4 max-sm:min-h-0 max-sm:items-start max-sm:pt-3 max-sm:pb-4">
      {children}
    </div>
  );
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
      {/* Flat on phones, like its loading skeleton: no surface, ring or inner
          padding, so the form sits on the page's 16px text line and the card's
          own vertical padding goes to the form. Overflow stays visible there
          so the inputs' focus rings are not clipped at the edge. */}
      <Card className="w-full max-w-md max-sm:overflow-visible max-sm:bg-transparent max-sm:py-0 max-sm:ring-0">
        <CardHeader className="text-center max-sm:px-0">
          <CardTitle className="text-2xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 max-sm:px-0">{children}</CardContent>
      </Card>
    </AuthScreen>
  );
}
