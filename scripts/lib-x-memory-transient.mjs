/** Only known transient database/transport failures; auth/schema errors fail closed. */
export function xMemoryTransientCode(error) {
 if(String(error?.message).includes("57014"))return "db_statement_timeout";
 if(error?.name === "TimeoutError" || (error?.name === "AbortError" && /timeout/i.test(error?.message||"")))return "db_transport_timeout";
 const code=error?.cause?.code || error?.code;
 if(["ETIMEDOUT","ECONNRESET","EPIPE","UND_ERR_CONNECT_TIMEOUT","UND_ERR_HEADERS_TIMEOUT","UND_ERR_SOCKET"].includes(code))return "db_transport_unavailable";
 return null;
}
