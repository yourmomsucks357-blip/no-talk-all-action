import requests
import urllib3
import sys
import json
urllib3.disable_warnings()

class WebScanner:
    def __init__(self, target):
        clean_target = target.replace("http://", "").replace("https://", "")
        try:
            test_url = "https://" + clean_target
            requests.get(test_url, verify=False, timeout=3)
            self.target = test_url
        except requests.exceptions.RequestException:
            self.target = "http://" + clean_target
        self.results = {"target": self.target, "findings": []}

    def check_headers(self):
        try:
            r = requests.get(self.target, verify=False, timeout=10)
            headers = dict(r.headers)
            security_headers = ["X-Frame-Options","X-Content-Type-Options","Strict-Transport-Security","Content-Security-Policy","X-XSS-Protection"]
            for h in security_headers:
                if h not in headers:
                    self.results["findings"].append({"type":"missing_header","header":h,"severity":"medium"})
            self.results["status_code"] = r.status_code
            self.results["server"] = headers.get("Server", "Unknown")
        except Exception as e:
            self.results["error"] = str(e)

    def check_common_paths(self):
        paths = ["/admin","/login","/wp-admin","/.env","/.git/config","/robots.txt","/sitemap.xml","/api"]
        for path in paths:
            try:
                r = requests.get(self.target + path, verify=False, timeout=5, allow_redirects=False)
                if r.status_code < 400:
                    sev = "high" if path in ["/.env","/.git/config"] else "info"
                    self.results["findings"].append({"type":"exposed_path","path":path,"status":r.status_code,"severity":sev})
            except:
                pass

    def run(self):
        self.check_headers()
        self.check_common_paths()
        return self.results

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "scanme.nmap.org"
    print(json.dumps(WebScanner(target).run(), indent=2))