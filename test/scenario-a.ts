// @ts-nocheck
// Scenario A — Tier-1 demo: null/undefined access without guard (intentionally buggy fixture)
// getUserEmail accesses user.profile.email — profile may be undefined

interface UserProfile {
  email: string;
  displayName: string;
}

interface User {
  id: string;
  name: string;
  profile?: UserProfile;
}

function getUserEmail(user: User): string {
  // No null check on user.profile before accessing .email
  return user.profile.email;
}

export { getUserEmail, User, UserProfile };
