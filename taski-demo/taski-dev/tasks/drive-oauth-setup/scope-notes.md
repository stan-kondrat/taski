# Drive scope notes

Taski uses `drive.file`: it sees only files it created or that the user picked in
the Google Picker ("Add from Drive"). Google counts that scope as non-sensitive, so
the app can be public without a security review.

The cost: Markdown that agents or other tools add to the Drive folder stays hidden
until the user picks it. The full `drive` scope would show everything, but it is
restricted and needs Google's verification, and maybe a yearly security assessment,
before anyone outside the test-user list could sign in. So Taski uses full `drive`
only with your own client ID, kept in testing mode for yourself.
