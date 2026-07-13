import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Sign-in surface. Starts the Keycloak OIDC flow.
 */
export function SignIn() {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-4 text-xl font-semibold">Sign in to Holotable</h1>
      <Card>
        <CardContent>
          <a href="/api/auth/login">
            <Button className="w-full">Sign in with Keycloak</Button>
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
