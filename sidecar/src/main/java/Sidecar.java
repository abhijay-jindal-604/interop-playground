// JVM sidecar (plan/10 section 6, plan/04 sections 2.7 and 3.8). One class, JDK HttpServer + Gson, no framework.
// Subcommands: smoke [sdjwt-file [ldp-file]] | issue <base> <configId> <claimsFile> <holderKeyJson> | serve <port>
// The sidecar is stateless on disk and holds no keys: the BFF signs every proof and VP token (ADR-09).
import com.google.gson.*;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.mosip.openID4VP.OpenID4VP;
import io.mosip.openID4VP.authorizationRequest.AuthorizationDcqlRequest;
import io.mosip.openID4VP.authorizationRequest.AuthorizationRequest;
import io.mosip.openID4VP.authorizationRequest.LdpVpFormatSupported;
import io.mosip.openID4VP.authorizationRequest.SdJwtVpFormatSupported;
import io.mosip.openID4VP.authorizationRequest.VPFormatSupported;
import io.mosip.openID4VP.authorizationRequest.Verifier;
import io.mosip.openID4VP.authorizationRequest.WalletConfig;
import io.mosip.openID4VP.authorizationResponse.unsignedVPToken.UnsignedVPToken;
import io.mosip.openID4VP.authorizationResponse.vpTokenSigningResult.VPTokenSigningResult;
import io.mosip.openID4VP.constants.ClientIdPrefix;
import io.mosip.openID4VP.constants.FormatType;
import io.mosip.openID4VP.constants.ResponseType;
import io.mosip.openID4VP.constants.SignatureAlgorithm;
import io.mosip.openID4VP.constants.VPFormatType;
import io.mosip.openID4VP.wallet.Credential;
import io.mosip.vciclient.VCIClient;
import io.mosip.vciclient.authorizationCodeFlow.clientMetadata.ClientMetadata;
import io.mosip.vciclient.credential.response.CredentialResponse;
import io.mosip.vciclient.proof.CredentialRequestProofs;
import io.mosip.vciclient.token.TokenResponse;
import io.mosip.vercred.vcverifier.CredentialsVerifier;
import io.mosip.vercred.vcverifier.constants.CredentialFormat;
import java.io.IOException;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPrivateKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPrivateKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlinx.coroutines.BuildersKt;

public class Sidecar {
  static final String VERSION = "0.1.0";
  // Keep in step with build.gradle.kts / gradle.lockfile.
  static final String JAR_VCI = "1.0.0-alpha.1", JAR_VP = "1.0.0-alpha.1", JAR_VERIFIER = "1.9.0";
  static final Gson G = new Gson();
  static final HttpClient H = HttpClient.newHttpClient(); // honours javax.net.ssl.trustStore (JAVA_TOOL_OPTIONS in the container)
  static final SecureRandom RND = new SecureRandom();
  static final long LONG_POLL_MS = Long.getLong("sidecar.longPollMs", 25_000L);
  static final long CALLBACK_WAIT_MS = Long.getLong("sidecar.callbackWaitMs", 120_000L);

  static String b64u(byte[] b) { return Base64.getUrlEncoder().withoutPadding().encodeToString(b); }

  /** 26-character ULID (Crockford base32): 48-bit time + 80-bit randomness. */
  static String ulid() {
    final String a = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    char[] out = new char[26];
    long t = System.currentTimeMillis();
    for (int i = 9; i >= 0; i--) { out[i] = a.charAt((int) (t & 31)); t >>>= 5; }
    for (int i = 10; i < 26; i++) out[i] = a.charAt(RND.nextInt(32));
    return new String(out);
  }

  static String http(String m, String url, String ct, String body, String bearer) throws Exception {
    var rb = HttpRequest.newBuilder(URI.create(url)).method(m, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
    if (ct != null) rb.header("Content-Type", ct);
    if (bearer != null) rb.header("Authorization", "Bearer " + bearer);
    var r = H.send(rb.build(), HttpResponse.BodyHandlers.ofString());
    if (r.statusCode() >= 300) throw new RuntimeException(r.statusCode() + " " + r.body());
    return r.body();
  }

  // ---------------------------------------------------------------- formats

  static CredentialFormat vcFormat(String f) {
    return switch (f) {
      case "ldp_vc" -> CredentialFormat.LDP_VC;
      case "dc+sd-jwt" -> CredentialFormat.DC_SD_JWT;
      case "mso_mdoc" -> CredentialFormat.MSO_MDOC;
      case "jwt_vc_json" -> CredentialFormat.JWT_VC_JSON;
      case "LDP_VC", "DC_SD_JWT", "MSO_MDOC", "JWT_VC_JSON", "VC_SD_JWT", "CWT_VC" -> CredentialFormat.valueOf(f);
      default -> throw new Bad("unsupported format: " + f);
    };
  }

  static FormatType vpFormat(String f) {
    return switch (f) {
      case "ldp_vc" -> FormatType.LDP_VC;
      case "dc+sd-jwt" -> FormatType.DC_SD_JWT;
      case "mso_mdoc" -> FormatType.MSO_MDOC;
      default -> throw new Bad("unsupported format for a presentation: " + f);
    };
  }

  static String guessFormat(JsonElement c) {
    if (c.isJsonObject()) return "ldp_vc";
    String s = c.getAsString();
    if (s.contains("~") || s.split("\\.").length == 3) return "dc+sd-jwt";
    return "mso_mdoc";
  }

  // ---------------------------------------------------------------- API-69 verify (also used by smoke)

  static JsonObject verify(String format, String cred) {
    long t0 = System.currentTimeMillis();
    var v = new CredentialsVerifier().verify(cred, vcFormat(format), false);
    JsonObject o = new JsonObject();
    o.addProperty("verified", v.getVerificationStatus());
    o.addProperty("errorCode", String.valueOf(v.getVerificationErrorCode()));
    o.addProperty("message", String.valueOf(v.getVerificationMessage()));
    o.addProperty("ms", System.currentTimeMillis() - t0);
    return o;
  }

  // ---------------------------------------------------------------- API-61..65 VCIClient sessions

  static final class Cb {
    final String id = ulid();
    final String type;
    final JsonObject json;
    final CompletableFuture<JsonObject> answer = new CompletableFuture<>();
    Cb(String type, JsonObject json) { this.type = type; this.json = json; this.json.addProperty("id", id); this.json.addProperty("type", type); }
  }

  static final class VciSession {
    final String id = ulid();
    final List<Cb> callbacks = new ArrayList<>();
    volatile JsonObject result = null; // null while running
    volatile Thread thread;
    synchronized Cb add(Cb c) { callbacks.add(c); notifyAll(); return c; }
    synchronized void finish(JsonObject r) { result = r; notifyAll(); }
  }

  static final Map<String, VciSession> VCI = new ConcurrentHashMap<>();

  static Object await(VciSession s, Cb c) throws Exception {
    s.add(c);
    try {
      return c.answer.get(CALLBACK_WAIT_MS, TimeUnit.MILLISECONDS);
    } catch (java.util.concurrent.TimeoutException e) {
      throw new IllegalStateException("callback " + c.type + " was not answered within " + CALLBACK_WAIT_MS + " ms");
    }
  }

  static VciSession startVci(String offerUri, JsonObject clientMetadata) {
    VciSession s = new VciSession();
    VCI.put(s.id, s);
    String cid = clientMetadata != null && clientMetadata.has("clientId") ? clientMetadata.get("clientId").getAsString() : "interop-playground";
    String red = clientMetadata != null && clientMetadata.has("redirectUri") ? clientMetadata.get("redirectUri").getAsString() : "app://cb";
    Thread t = new Thread(() -> {
      try {
        VCIClient c = new VCIClient("playground-" + s.id);
        Object r = BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE, (scope, cont) -> c.fetchCredentialsUsingCredentialOffer(
          offerUri, new ClientMetadata(cid, red),
          // tx_code callback: (inputMode, description, length) -> code, answered by the BFF
          (inputMode, description, length, k) -> {
            try {
              JsonObject j = new JsonObject();
              j.addProperty("inputMode", inputMode == null ? "numeric" : inputMode);
              if (length == null) j.add("length", JsonNull.INSTANCE); else j.addProperty("length", length);
              if (description == null) j.add("description", JsonNull.INSTANCE); else j.addProperty("description", description);
              JsonObject a = (JsonObject) await(s, new Cb("txcode", j));
              return a.get("txCode").getAsString();
            } catch (Exception e) { throw new RuntimeException(e); }
          },
          List.of(),
          // token callback: the sidecar posts the token request itself (hops go through the gateway)
          (tr, k) -> {
            try {
              String form = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Apre-authorized_code&pre-authorized_code=" + tr.getPreAuthCode()
                + (tr.getTxCode() != null ? "&tx_code=" + java.net.URLEncoder.encode(tr.getTxCode(), StandardCharsets.UTF_8) : "");
              String body = http("POST", tr.getTokenEndpoint(), "application/x-www-form-urlencoded", form, null);
              return new TokenResponse(JsonParser.parseString(body).getAsJsonObject().get("access_token").getAsString(), "Bearer", 300, null, null);
            } catch (Exception e) { throw new RuntimeException(e); }
          },
          // proof callback: (aud, nonce, algs) -> BFF-signed JWS
          (aud, nonce, algs, k) -> {
            try {
              JsonObject j = new JsonObject();
              j.addProperty("aud", aud);
              if (nonce == null) j.add("nonce", JsonNull.INSTANCE); else j.addProperty("nonce", nonce);
              JsonArray arr = new JsonArray();
              if (algs != null) for (String a : algs) arr.add(a);
              j.add("alg", arr);
              JsonObject a = (JsonObject) await(s, new Cb("proof", j));
              return new CredentialRequestProofs("jwt", List.of(a.get("jws").getAsString()));
            } catch (Exception e) { throw new RuntimeException(e); }
          },
          (issuer, configs, k) -> Boolean.TRUE, 20000L, cont));
        CredentialResponse cr = (CredentialResponse) r;
        JsonElement cred = cr.getCredentials().get(0).getCredential();
        JsonObject o = new JsonObject();
        o.addProperty("state", "done");
        o.add("credential", cred.isJsonPrimitive() ? cred : cred);
        o.addProperty("configId", cr.getCredentialConfigurationId());
        o.addProperty("format", guessFormat(cred));
        s.finish(o);
      } catch (Throwable e) {
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) root = root.getCause();
        JsonObject o = new JsonObject();
        o.addProperty("state", "failed");
        o.addProperty("exceptionClass", root.getClass().getName());
        o.addProperty("message", String.valueOf(root.getMessage()));
        s.finish(o);
      }
    }, "vci-" + s.id);
    t.setDaemon(true);
    s.thread = t;
    t.start();
    return s;
  }

  // ---------------------------------------------------------------- API-66..68 OpenID4VP

  static final class VpSession {
    final String id = ulid();
    OpenID4VP vp;
    AuthorizationRequest req;
    List<UnsignedVPToken> unsigned;
  }

  static final Map<String, VpSession> VP = new ConcurrentHashMap<>();

  static JsonElement dcqlOf(AuthorizationRequest r, String urlEncodedRequest) {
    if (r instanceof AuthorizationDcqlRequest d) {
      try { return G.toJsonTree(d.getDcqlQuery()); } catch (Throwable ignored) { /* fall through to the URL */ }
    }
    Matcher m = Pattern.compile("[?&]dcql_query=([^&]*)").matcher(urlEncodedRequest == null ? "" : urlEncodedRequest);
    if (m.find()) {
      try { return JsonParser.parseString(URLDecoder.decode(m.group(1), StandardCharsets.UTF_8)); } catch (Exception ignored) { /* none */ }
    }
    return JsonNull.INSTANCE;
  }

  static WalletConfig walletConfig(JsonObject req) {
    JsonObject md = req.has("walletMetadata") && req.get("walletMetadata").isJsonObject() ? req.getAsJsonObject("walletMetadata") : new JsonObject();
    List<SignatureAlgorithm> reqAlgs = new ArrayList<>();
    if (md.has("requestObjectSigningAlgValuesSupported")) {
      for (JsonElement e : md.getAsJsonArray("requestObjectSigningAlgValuesSupported")) reqAlgs.add(SignatureAlgorithm.valueOf(e.getAsString()));
    } else reqAlgs.add(SignatureAlgorithm.EdDSA); // S-205, ADR-48: the only value the jar's enum has
    List<Verifier> trusted = new ArrayList<>();
    if (req.has("trustedVerifiers")) {
      for (JsonElement e : req.getAsJsonArray("trustedVerifiers")) {
        JsonObject v = e.getAsJsonObject();
        List<String> uris = new ArrayList<>();
        for (JsonElement u : v.getAsJsonArray("responseUris")) uris.add(u.getAsString());
        trusted.add(new Verifier(v.get("clientId").getAsString(), uris));
      }
    }
    Map<VPFormatType, VPFormatSupported> formats = new HashMap<>();
    formats.put(VPFormatType.DC_SD_JWT, new SdJwtVpFormatSupported(List.of("ES256"), List.of("ES256")));
    formats.put(VPFormatType.LDP_VC, new LdpVpFormatSupported());
    return new WalletConfig(formats,
      List.of(ClientIdPrefix.PRE_REGISTERED, ClientIdPrefix.REDIRECT_URI, ClientIdPrefix.DECENTRALIZED_IDENTIFIER),
      reqAlgs, List.of(), List.of(), List.of(ResponseType.VP_TOKEN), false, trusted, !trusted.isEmpty());
  }

  // ---------------------------------------------------------------- HTTP plumbing

  static final class Bad extends RuntimeException { Bad(String m) { super(m); } }
  static final class NotFound extends RuntimeException { NotFound(String m) { super(m); } }
  static final class Conflict extends RuntimeException { Conflict(String m) { super(m); } }
  static final class Engine extends RuntimeException { final Throwable t; Engine(Throwable t) { super(String.valueOf(t.getMessage())); this.t = t; } }

  static JsonObject body(HttpExchange x) {
    try {
      String s = new String(x.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
      JsonElement e = JsonParser.parseString(s.isBlank() ? "{}" : s);
      if (!e.isJsonObject()) throw new Bad("body must be a JSON object");
      return e.getAsJsonObject();
    } catch (JsonParseException | IOException e) { throw new Bad("body is not valid JSON"); }
  }

  static String str(JsonObject o, String k) {
    if (!o.has(k) || !o.get(k).isJsonPrimitive()) throw new Bad("missing or invalid field: " + k);
    return o.get(k).getAsString();
  }

  static void reply(HttpExchange x, int code, String json) throws IOException {
    byte[] b = json == null ? new byte[0] : json.getBytes(StandardCharsets.UTF_8);
    x.getResponseHeaders().set("Content-Type", "application/json");
    x.sendResponseHeaders(code, code == 204 ? -1 : b.length);
    if (code != 204) x.getResponseBody().write(b);
    x.close();
  }

  static void error(HttpExchange x, int status, String code, String message, JsonObject details) throws IOException {
    String rid = ulid();
    JsonObject e = new JsonObject();
    e.addProperty("code", code);
    e.addProperty("message", message);
    e.addProperty("status", status);
    e.addProperty("requestId", rid);
    e.addProperty("retryable", false);
    if (details != null) e.add("details", details);
    JsonObject o = new JsonObject();
    o.add("error", e);
    x.getResponseHeaders().set("X-Request-Id", rid);
    reply(x, status, o.toString());
  }

  static final Pattern VCI_ROOT = Pattern.compile("^/vci/sessions$");
  static final Pattern VCI_ONE = Pattern.compile("^/vci/sessions/([0-9A-Z]{26})$");
  static final Pattern VCI_PENDING = Pattern.compile("^/vci/sessions/([0-9A-Z]{26})/pending$");
  static final Pattern VCI_ANSWER = Pattern.compile("^/vci/sessions/([0-9A-Z]{26})/answers/([0-9A-Z]{26})$");
  static final Pattern VCI_RESULT = Pattern.compile("^/vci/sessions/([0-9A-Z]{26})/result$");

  static VciSession vci(String id) {
    VciSession s = VCI.get(id);
    if (s == null) throw new NotFound("no such session");
    return s;
  }

  static void route(HttpExchange x) throws Exception {
    String m = x.getRequestMethod(), p = x.getRequestURI().getPath();
    Matcher g;
    if (m.equals("GET") && p.equals("/health")) {
      JsonObject jars = new JsonObject();
      jars.addProperty("vciClient", JAR_VCI); jars.addProperty("openid4vp", JAR_VP); jars.addProperty("vcverifier", JAR_VERIFIER);
      JsonObject o = new JsonObject();
      o.addProperty("status", "ok"); o.addProperty("version", VERSION); o.add("jars", jars);
      reply(x, 200, o.toString());
    } else if (m.equals("POST") && VCI_ROOT.matcher(p).matches()) {                       // API-61
      JsonObject b = body(x);
      String offer = str(b, "offerUri");
      if (!offer.startsWith("openid-credential-offer://")) throw new Bad("offerUri must start with openid-credential-offer://");
      VciSession s = startVci(offer, b.has("clientMetadata") && b.get("clientMetadata").isJsonObject() ? b.getAsJsonObject("clientMetadata") : null);
      JsonObject o = new JsonObject(); o.addProperty("sessionId", s.id);
      reply(x, 201, o.toString());
    } else if (m.equals("GET") && (g = VCI_PENDING.matcher(p)).matches()) {              // API-62
      VciSession s = vci(g.group(1));
      int after = 0;
      String q = x.getRequestURI().getQuery();
      if (q != null) { Matcher a = Pattern.compile("(?:^|&)after=(\\d+)").matcher(q); if (a.find()) after = Integer.parseInt(a.group(1)); }
      long deadline = System.currentTimeMillis() + LONG_POLL_MS;
      JsonArray arr = new JsonArray();
      int next;
      synchronized (s) {
        while (s.callbacks.size() <= after && s.result == null) {
          long left = deadline - System.currentTimeMillis();
          if (left <= 0) break;
          s.wait(left);
        }
        for (int i = after; i < s.callbacks.size(); i++) arr.add(s.callbacks.get(i).json);
        next = s.callbacks.size();
      }
      JsonObject o = new JsonObject(); o.add("callbacks", arr); o.addProperty("next", next);
      reply(x, 200, o.toString());
    } else if (m.equals("POST") && (g = VCI_ANSWER.matcher(p)).matches()) {              // API-63
      VciSession s = vci(g.group(1));
      final String cbId = g.group(2);
      Cb cb;
      synchronized (s) { cb = s.callbacks.stream().filter(c -> c.id.equals(cbId)).findFirst().orElse(null); }
      if (cb == null) throw new NotFound("no such callback");
      JsonObject b = body(x);
      if (cb.type.equals("proof")) str(b, "jws"); else str(b, "txCode");
      if (!cb.answer.complete(b)) throw new Conflict("callback already answered");
      reply(x, 204, null);
    } else if (m.equals("GET") && (g = VCI_RESULT.matcher(p)).matches()) {               // API-64
      VciSession s = vci(g.group(1));
      JsonObject r = s.result;
      if (r == null) { JsonObject o = new JsonObject(); o.addProperty("state", "running"); reply(x, 202, o.toString()); }
      else reply(x, 200, r.toString());
    } else if (m.equals("DELETE") && (g = VCI_ONE.matcher(p)).matches()) {               // API-65
      VciSession s = VCI.remove(g.group(1));
      if (s != null) {
        synchronized (s) { for (Cb c : s.callbacks) c.answer.completeExceptionally(new IllegalStateException("session aborted")); }
        if (s.result == null && s.thread != null) s.thread.interrupt();
      }
      reply(x, 204, null);
    } else if (m.equals("POST") && p.equals("/vp/authenticate")) {                       // API-66
      JsonObject b = body(x);
      String uri = str(b, "urlEncodedRequest");
      if (!b.has("trustedVerifiers") || !b.get("trustedVerifiers").isJsonArray()) throw new Bad("missing or invalid field: trustedVerifiers");
      VpSession s = new VpSession();
      try {
        s.vp = new OpenID4VP("playground-" + s.id, walletConfig(b));
        s.req = s.vp.authenticateVerifier(uri);
      } catch (Bad e) { throw e; } catch (Throwable e) { throw new Engine(e); }
      VP.put(s.id, s);
      JsonObject ar = new JsonObject();
      ar.addProperty("clientId", s.req.getClientId());
      ar.addProperty("responseUri", s.req.getResponseUri());
      ar.addProperty("nonce", s.req.getNonce());
      ar.addProperty("state", s.req.getState());
      ar.addProperty("responseMode", s.req.getResponseMode());
      ar.add("dcqlQuery", dcqlOf(s.req, uri));
      JsonObject o = new JsonObject(); o.add("authorizationRequest", ar); o.addProperty("sessionId", s.id);
      reply(x, 200, o.toString());
    } else if (m.equals("POST") && p.equals("/vp/unsigned-token")) {                     // API-67
      JsonObject b = body(x);
      VpSession s = VP.get(str(b, "sessionId"));
      if (s == null) throw new NotFound("no such session");
      if (!b.has("credential") || !b.get("credential").isJsonObject()) throw new Bad("missing or invalid field: credential");
      JsonObject c = b.getAsJsonObject("credential");
      FormatType ft = vpFormat(str(c, "format"));
      String raw = str(c, "raw");
      // The jar selects claims from the DCQL query itself (S-060); `disclosure` and `holderDid` are accepted for the contract and not needed by the jar.
      String queryId = "pg";
      JsonElement dq = dcqlOf(s.req, "");
      if (dq.isJsonObject() && dq.getAsJsonObject().has("credentials") && dq.getAsJsonObject().get("credentials").isJsonArray()
          && dq.getAsJsonObject().getAsJsonArray("credentials").size() > 0) {
        JsonObject first = dq.getAsJsonObject().getAsJsonArray("credentials").get(0).getAsJsonObject();
        if (first.has("id")) queryId = first.get("id").getAsString();
      }
      List<UnsignedVPToken> u;
      try {
        Object data = ft == FormatType.LDP_VC ? JsonParser.parseString(raw).toString() : raw;
        u = s.vp.constructUnsignedVPToken(Map.of(queryId, List.of(new Credential(ft, data, queryId))));
      } catch (Throwable e) { throw new Engine(e); }
      if (u.size() != 1) throw new Bad("expected exactly one unsigned token, the jar produced " + u.size());
      s.unsigned = u;
      JsonObject o = new JsonObject();
      o.addProperty("toSign", b64u(u.get(0).getDataToSign()));   // base64url of the exact bytes to sign
      o.addProperty("alg", u.get(0).getSignatureAlgorithm());
      reply(x, 200, o.toString());
    } else if (m.equals("POST") && p.equals("/vp/response")) {                           // API-68
      JsonObject b = body(x);
      VpSession s = VP.get(str(b, "sessionId"));
      if (s == null) throw new NotFound("no such session");
      if (s.unsigned == null) throw new Bad("call /vp/unsigned-token first");
      byte[] sig = Base64.getUrlDecoder().decode(str(b, "signature"));
      Map<String, Object> resp;
      try {
        resp = s.vp.constructVPResponse(List.of(new VPTokenSigningResult(s.unsigned.get(0).getId(), sig)));
      } catch (Throwable e) { throw new Engine(e); }
      Object tok = resp.get("vp_token");
      JsonObject o = new JsonObject();
      o.addProperty("vpToken", tok instanceof String ? (String) tok : G.toJson(tok));
      Object st = resp.get("state");
      o.addProperty("state", st != null ? String.valueOf(st) : s.req.getState());
      o.addProperty("responseUri", s.req.getResponseUri());
      reply(x, 200, o.toString());
    } else if (m.equals("POST") && p.equals("/vc/verify")) {                             // API-69
      JsonObject b = body(x);
      String fmt = str(b, "format"), raw = str(b, "raw");
      vcFormat(fmt);
      try {
        var v = new CredentialsVerifier().verify(raw, vcFormat(fmt), false);
        JsonObject o = new JsonObject();
        o.addProperty("verificationStatus", v.getVerificationStatus());
        String code = v.getVerificationErrorCode();
        if (code == null || code.isEmpty()) o.add("code", JsonNull.INSTANCE); else o.addProperty("code", code);
        String msg = v.getVerificationMessage();
        if (msg == null || msg.isEmpty()) o.add("message", JsonNull.INSTANCE); else o.addProperty("message", msg);
        o.add("rawResult", G.toJsonTree(Map.of("verificationStatus", v.getVerificationStatus(),
          "verificationMessage", String.valueOf(v.getVerificationMessage()), "verificationErrorCode", String.valueOf(v.getVerificationErrorCode()))));
        reply(x, 200, o.toString());
      } catch (Throwable e) { throw new Engine(e); }
    } else {
      throw new NotFound("no such route");
    }
  }

  static void handle(HttpExchange x) throws IOException {
    try {
      route(x);
    } catch (Bad e) { error(x, 400, "validation_failed", e.getMessage(), null);
    } catch (NotFound e) { error(x, 404, "not_found", e.getMessage(), null);
    } catch (Conflict e) { error(x, 409, "callback_not_pending", e.getMessage(), null);
    } catch (Engine e) {
      Throwable root = e.t;
      JsonObject d = new JsonObject();
      d.addProperty("exceptionClass", root.getClass().getName());
      d.addProperty("message", String.valueOf(root.getMessage()));
      error(x, 422, "engine_exception", "The library threw " + root.getClass().getSimpleName() + ".", d);
    } catch (Exception e) {
      System.err.println("internal error: " + e);
      error(x, 500, "internal_error", "Internal error.", null);
    }
  }

  static void serve(String bind, int port) throws Exception {
    HttpServer s = HttpServer.create(new InetSocketAddress(bind, port), 0);
    s.createContext("/", Sidecar::handle);
    s.setExecutor(Executors.newCachedThreadPool(r -> { Thread t = new Thread(r); t.setDaemon(false); return t; }));
    s.start();
    System.out.println("sidecar listening on " + bind + ":" + port);
  }

  // ---------------------------------------------------------------- issue (developer CLI, S-185)

  /** issue: mint pre-auth offer -> VCIClient (token cb, P1363 proof cb signed locally) -> credential. For dev and CI only. */
  static String issue(String base, String cfg, JsonObject claims, JsonObject holderKey) throws Exception {
    String mint = System.getProperty("mintBase", base);
    ECPrivateKey priv = (ECPrivateKey) KeyFactory.getInstance("EC").generatePrivate(new ECPrivateKeySpec(
      new BigInteger(1, Base64.getUrlDecoder().decode(holderKey.get("d").getAsString())), ec()));
    String jwk = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"" + holderKey.get("x").getAsString() + "\",\"y\":\"" + holderKey.get("y").getAsString() + "\"}";
    String didJwk = "did:jwk:" + b64u(jwk.getBytes(StandardCharsets.UTF_8));
    JsonObject req = new JsonObject(); req.addProperty("credential_configuration_id", cfg); req.add("claims", claims); req.addProperty("expires_in", 600);
    String offer = JsonParser.parseString(http("POST", mint + "/v1/certify/pre-authorized-data", "application/json", req.toString(), null)).getAsJsonObject().get("credential_offer_uri").getAsString();
    VCIClient c = new VCIClient("playground-issue-cli");
    Object r = BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE, (scope, cont) -> c.fetchCredentialsUsingCredentialOffer(
      offer, new ClientMetadata("interop-playground", "app://cb"),
      (u1, u2, u3, k) -> { throw new IllegalStateException("tx code not expected"); },
      List.of(),
      (tr, k) -> { try {
        String t = http("POST", tr.getTokenEndpoint(), "application/x-www-form-urlencoded",
          "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Apre-authorized_code&pre-authorized_code=" + tr.getPreAuthCode(), null);
        return new TokenResponse(JsonParser.parseString(t).getAsJsonObject().get("access_token").getAsString(), "Bearer", 300, null, null);
      } catch (Exception e) { throw new RuntimeException(e); } },
      (iss, nonce, algs, k) -> { try {
        String hdr = b64u(("{\"alg\":\"ES256\",\"typ\":\"openid4vci-proof+jwt\",\"kid\":\"" + didJwk + "#0\"}").getBytes(StandardCharsets.UTF_8));
        String pl = "{\"aud\":\"" + iss + "\",\"iat\":" + (System.currentTimeMillis() / 1000) + (nonce != null ? ",\"nonce\":\"" + nonce + "\"" : "") + "}";
        String si = hdr + "." + b64u(pl.getBytes(StandardCharsets.UTF_8));
        Signature s = Signature.getInstance("SHA256withECDSAinP1363Format"); s.initSign(priv); s.update(si.getBytes(StandardCharsets.US_ASCII));
        return new CredentialRequestProofs("jwt", List.of(si + "." + b64u(s.sign())));
      } catch (Exception e) { throw new RuntimeException(e); } },
      (i1, i2, k) -> Boolean.TRUE, 20000L, cont));
    var el = ((CredentialResponse) r).getCredentials().get(0).getCredential();
    return el.isJsonPrimitive() ? el.getAsString() : el.toString();
  }

  static ECParameterSpec ec() throws Exception {
    var ap = AlgorithmParameters.getInstance("EC"); ap.init(new ECGenParameterSpec("secp256r1")); return ap.getParameterSpec(ECParameterSpec.class);
  }

  // ---------------------------------------------------------------- main

  public static void main(String[] a) throws Exception {
    if (a.length == 0) throw new IllegalArgumentException("smoke|issue|serve");
    switch (a[0]) {
      case "smoke" -> {
        boolean ok = true;
        if (a.length > 1) {
          String sd = Files.readString(Path.of(a[1])).trim();
          JsonObject good = verify("dc+sd-jwt", sd);
          System.out.println("verify dc+sd-jwt: " + good);
          int i = sd.indexOf('~'); String jwt = sd.substring(0, i); char c = jwt.charAt(jwt.length() - 5);
          JsonObject bad = verify("dc+sd-jwt", jwt.substring(0, jwt.length() - 5) + (c == 'A' ? 'B' : 'A') + jwt.substring(jwt.length() - 4) + sd.substring(i));
          System.out.println("verify dc+sd-jwt tampered: " + bad);
          ok &= good.get("verified").getAsBoolean() && !bad.get("verified").getAsBoolean();
        }
        if (a.length > 2) {
          JsonObject ldp = verify("ldp_vc", Files.readString(Path.of(a[2])).trim());
          System.out.println("verify ldp_vc: " + ldp);
          ok &= ldp.get("verified").getAsBoolean();
        }
        System.out.println("VCIClient traceId: " + new VCIClient("playground-smoke").getTraceabilityId());
        System.out.println(ok ? "SMOKE PASS" : "SMOKE FAIL");
        if (!ok) System.exit(1);
      }
      case "issue" -> System.out.println(issue(a[1], a[2], JsonParser.parseString(Files.readString(Path.of(a[3]))).getAsJsonObject(),
        JsonParser.parseString(Files.readString(Path.of(a[4]))).getAsJsonObject()));
      case "serve" -> serve(System.getenv().getOrDefault("SIDECAR_BIND", "0.0.0.0"), Integer.parseInt(a[1]));
      default -> throw new IllegalArgumentException("smoke|issue|serve");
    }
  }
}
