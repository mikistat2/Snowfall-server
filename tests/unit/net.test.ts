import { describe, it, expect } from 'vitest';
import { isPrivateHttpUrl } from '../../src/utils/net';

describe('isPrivateHttpUrl (camera proxy SSRF guard)', () => {
  it('allows LAN and loopback addresses', () => {
    expect(isPrivateHttpUrl('http://192.168.1.50:8080/video')).toBe(true);
    expect(isPrivateHttpUrl('http://10.0.0.7/shot.jpg')).toBe(true);
    expect(isPrivateHttpUrl('http://172.16.4.2:8080/video')).toBe(true);
    expect(isPrivateHttpUrl('http://172.31.255.1/video')).toBe(true);
    expect(isPrivateHttpUrl('http://127.0.0.1:8080/video')).toBe(true);
    expect(isPrivateHttpUrl('http://localhost:8080/video')).toBe(true);
    expect(isPrivateHttpUrl('https://cam.local/stream')).toBe(true);
    expect(isPrivateHttpUrl('http://169.254.10.10/video')).toBe(true);
  });

  it('rejects public addresses and hostnames', () => {
    expect(isPrivateHttpUrl('http://8.8.8.8/video')).toBe(false);
    expect(isPrivateHttpUrl('http://172.32.0.1/video')).toBe(false); // just outside /12
    expect(isPrivateHttpUrl('http://93.184.216.34:8080/video')).toBe(false);
    expect(isPrivateHttpUrl('http://example.com/video')).toBe(false);
    expect(isPrivateHttpUrl('http://evil.com/redirect?to=192.168.1.1')).toBe(false);
  });

  it('rejects non-http schemes and garbage', () => {
    expect(isPrivateHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isPrivateHttpUrl('ftp://192.168.1.50/video')).toBe(false);
    expect(isPrivateHttpUrl('not a url')).toBe(false);
    expect(isPrivateHttpUrl('')).toBe(false);
  });
});
