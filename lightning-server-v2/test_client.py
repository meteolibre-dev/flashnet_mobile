"""
Test client for Lightning Server V2
Usage: python test_client.py [base_url]
"""

import sys
import requests
import time


BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3001"


def test_endpoint(name, url, expected_status=200):
    """Test an endpoint and print results."""
    print(f"\n{'='*60}")
    print(f"Testing: {name}")
    print(f"URL: {url}")
    print(f"{'='*60}")

    try:
        start = time.time()
        response = requests.get(url, timeout=30)
        elapsed = time.time() - start

        if response.status_code == expected_status:
            print(f"✓ Success ({response.status_code}) in {elapsed:.3f}s")

            # Try to parse JSON
            try:
                data = response.json()
                print(f"Response: {data}")
            except:
                # Not JSON, might be binary
                content_type = response.headers.get('content-type', '')
                if 'image' in content_type:
                    size = len(response.content)
                    print(f"Binary response: {content_type}, {size} bytes")
                else:
                    print(f"Response: {response.text[:200]}")
        else:
            print(f"✗ Failed: {response.status_code}")
            print(f"Response: {response.text[:500]}")

        return response.status_code == expected_status

    except requests.exceptions.ConnectionError:
        print(f"✗ Connection error - is the server running at {BASE_URL}?")
        return False
    except requests.exceptions.Timeout:
        print(f"✗ Timeout after 30s")
        return False
    except Exception as e:
        print(f"✗ Error: {e}")
        return False


def main():
    print(f"Testing Lightning Server V2 at {BASE_URL}")
    print(f"{'='*60}")

    results = []

    # Test root
    results.append(test_endpoint("Root", f"{BASE_URL}/"))

    # Test health
    results.append(test_endpoint("Health", f"{BASE_URL}/health"))

    # Test bands
    results.append(test_endpoint("Bands", f"{BASE_URL}/bands"))

    # Test times
    results.append(test_endpoint("Times", f"{BASE_URL}/times?hours=6"))

    # Test tile (if we have a known time)
    # Using a sample timestamp
    sample_time = "202601190100"

    results.append(test_endpoint(
        "TileJSON (lightning)",
        f"{BASE_URL}/tilejson?band=lightning&time={sample_time}"
    ))

    results.append(test_endpoint(
        "Bounds (sat_ch1)",
        f"{BASE_URL}/bounds?band=sat_ch1&time={sample_time}"
    ))

    # Test tile at z=4, x=8, y=4 (sample coordinates)
    results.append(test_endpoint(
        "Tile (lightning)",
        f"{BASE_URL}/tiles/4/8/4.png?band=lightning&time={sample_time}"
    ))

    results.append(test_endpoint(
        "Tile (sat_ch1)",
        f"{BASE_URL}/tiles/4/8/4.png?band=sat_ch1&time={sample_time}"
    ))

    # Summary
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    passed = sum(results)
    total = len(results)
    print(f"Passed: {passed}/{total}")

    if passed == total:
        print("✓ All tests passed!")
        return 0
    else:
        print("✗ Some tests failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
