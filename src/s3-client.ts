import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import type { PluginSettings } from './types';

async function hmacSha256(key: string | ArrayBuffer, data: string): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const keyData = typeof key === 'string' ? encoder.encode(key) : key;
    const cryptoKey = await crypto.subtle.importKey(
        'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
    const encoder = new TextEncoder();
    const buf = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(key: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
    let k: ArrayBuffer = new TextEncoder().encode("AWS4" + key).buffer;
    k = await hmacSha256(k, dateStamp);
    k = await hmacSha256(k, region);
    k = await hmacSha256(k, service);
    k = await hmacSha256(k, "aws4_request");
    return k;
}

export class S3Client {
    private settings: PluginSettings;
    
    constructor(settings: PluginSettings) {
        this.settings = settings;
    }
    
    private async signRequest(method: string, url: URL, headers: Record<string, string>, payloadHash: string): Promise<void> {
        const now = new Date();
        const dateStamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 8);
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
        const region = 'us-east-1'; // AWS4 Signature requires a region, often 'us-east-1' works for generic S3/R2 endpoints
        
        headers["X-Amz-Date"] = amzDate;
        headers["X-Amz-Content-Sha256"] = payloadHash;
        
        const signedHeaders = Object.keys(headers)
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
            .map((k) => k.toLowerCase())
            .join(";");
            
        const canonicalHeaders = Object.keys(headers)
            .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
            .map((k) => `${k.toLowerCase()}:${headers[k].trim()}`)
            .join("\n");
            
        const canonicalRequest = [
            method,
            url.pathname.split('/').map(c => encodeURIComponent(c)).join('/'),
            url.search.replace(/^\?/, ""),
            canonicalHeaders + "\n",
            signedHeaders,
            payloadHash,
        ].join("\n");
        
        const scope = `${dateStamp}/${region}/s3/aws4_request`;
        
        const stringToSign = [
            "AWS4-HMAC-SHA256",
            amzDate,
            scope,
            await sha256Hex(canonicalRequest)
        ].join("\n");
        
        const signingKey = await getSignatureKey(this.settings.s3SecretAccessKey, dateStamp, region, "s3");
        
        const encoder = new TextEncoder();
        const cryptoKey = await crypto.subtle.importKey(
            'raw', signingKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        const signatureBuf = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(stringToSign));
        const signature = Array.from(new Uint8Array(signatureBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
        
        headers["Authorization"] = `AWS4-HMAC-SHA256 Credential=${this.settings.s3AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    }
    
    /** Fetches an object. If the object key does not start with the prefix, the prefix is added. */
    async fetchObject(key: string): Promise<RequestUrlResponse> {
        let fullKey = key;
        let prefix = this.settings.s3Prefix || '';
        if (prefix && !prefix.endsWith('/')) {
            prefix += '/';
        }
        
        if (!fullKey.startsWith(prefix)) {
            fullKey = `${prefix}${fullKey}`;
        }
        
        const endpoint = this.settings.s3Endpoint.replace(/\/$/, '');
        const bucket = this.settings.s3Bucket;
        // The pathname should be constructed with encoded URI components if needed. 
        // URL constructor parses and encodes it appropriately.
        const urlStr = `${endpoint}/${bucket}/${fullKey}`;
        const url = new URL(urlStr);
        
        const emptyHash = await sha256Hex("");
        const headers: Record<string, string> = {
            "Host": url.host
        };
        
        await this.signRequest("GET", url, headers, emptyHash);
        
        // requestUrl throws ERR_INVALID_ARGUMENT if we explicitly pass the Host header, 
        // as Electron's network stack sets it automatically based on the URL.
        const requestHeaders = { ...headers };
        delete requestHeaders["Host"];
        delete requestHeaders["host"];
        
        const params: RequestUrlParam = {
            url: urlStr,
            method: "GET",
            headers: requestHeaders,
            throw: false
        };
        
        const response = await requestUrl(params);
        if (response.status >= 300) {
            throw new Error(`S3 Object fetch failed with status ${response.status}: ${response.text}`);
        }
        return response;
    }
}
