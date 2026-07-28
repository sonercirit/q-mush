export function oauthTokenResponse(options: {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
}): Response {
  return Response.json({
    access_token: options.accessToken,
    expires_in: 3600,
    id_token: options.idToken,
    refresh_token: options.refreshToken,
  });
}
