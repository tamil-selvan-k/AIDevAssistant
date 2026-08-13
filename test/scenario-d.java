// Scenario D — Tier-1 Java demo: String == comparison instead of .equals()
// Catchable by Java RuleEngine instantly, no LLM needed.

public class UserService {

    /**
     * Checks whether the user has the given role.
     * Uses == for String comparison which compares object references, not values.
     * This can silently fail when strings are not interned.
     */
    public boolean hasRole(String userRole, String requiredRole) {
        // Bug: == compares references, not String content
        if (userRole == requiredRole) {
            return true;
        }
        return false;
    }

    /**
     * Looks up user email by username.
     * Demonstrates chained access without null guard.
     */
    public String getUserEmail(User user) {
        // Bug: user.getProfile().getEmail() — getProfile() may return null
        return user.getProfile().getEmail();
    }
}
