import concurrent.futures
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class BookingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_patch = patch.object(server, "DB_PATH", Path(self.temp.name) / "test.sqlite3")
        self.db_patch.start()
        server.init_db()

    def tearDown(self):
        self.db_patch.stop()
        self.temp.cleanup()

    def test_catalog_has_cinemas_prices_and_seats(self):
        data = server.catalog()
        self.assertEqual(len(data["cinemas"]), 1)
        self.assertEqual(len(data["movies"]), 16)
        self.assertEqual(sum(bool(m["trailer_url"]) for m in data["movies"]), 12)
        self.assertTrue(all(m["poster"].startswith("/media/posters/") for m in data["movies"]))
        self.assertTrue(data["shows"])
        show = data["shows"][0]
        seats = server.show_details(show["id"])["seats"]
        self.assertTrue(any(s["kind"] == "sofa" for s in seats))
        self.assertGreater(len({s["price_rub"] for s in seats}), 1)
        self.assertTrue(any(s["occupied"] for s in seats))
        self.assertTrue(any(not s["occupied"] for s in seats))

    def test_booking_persists_and_second_booking_fails(self):
        show = server.catalog()["shows"][0]
        seat = server.show_details(show["id"])["seats"][0]
        status, result = server.create_order(show["id"], seat["id"], "Тест")
        self.assertEqual(status, 201)
        ticket = server.ticket_details(result["token"])
        self.assertEqual(ticket["price_rub"], seat["price_rub"])
        self.assertEqual(ticket["customer_name"], "Тест")
        self.assertTrue(next(s for s in server.show_details(show["id"])["seats"] if s["id"] == seat["id"])["occupied"])
        self.assertEqual(server.create_order(show["id"], seat["id"], "Другой")[0], 409)

    def test_concurrent_booking_has_single_winner(self):
        show = server.catalog()["shows"][0]
        seat = server.show_details(show["id"])["seats"][1]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: server.create_order(show["id"], seat["id"], "Гость")[0], range(2)))
        self.assertEqual(sorted(outcomes), [201, 409])

    def test_rejects_seat_from_another_cinema(self):
        data = server.catalog()
        first = data["shows"][0]
        with server.connect() as db:
            seat = db.execute("SELECT id FROM seats WHERE cinema_id != ? LIMIT 1", (first["cinema_id"],)).fetchone()
        self.assertIsNotNone(seat)
        self.assertEqual(server.create_order(first["id"], seat["id"], "Гость")[0], 404)

    def test_registration_and_demo_payment_issues_owned_ticket_once(self):
        status, account = server.register_user(" viewer@example.test ", "Зритель", "demo-password-123")
        self.assertEqual(status, 201)
        self.assertEqual(account["email"], "viewer@example.test")
        self.assertEqual(server.register_user("viewer@example.test", "Зритель", "demo-password-123")[0], 409)
        self.assertEqual(server.login_user("viewer@example.test", "wrong-password")[0], 401)
        self.assertEqual(server.login_user("viewer@example.test", "demo-password-123")[0], 200)
        session = server.new_session(account["id"])
        self.assertEqual(server.user_from_token(session)["id"], account["id"])
        show = server.catalog()["shows"][0]
        seat = next(s for s in server.show_details(show["id"])["seats"] if not s["occupied"])
        status, payment = server.create_demo_payment(account["id"], show["id"], seat["id"])
        self.assertEqual(status, 201)
        self.assertEqual(server.create_demo_payment(account["id"], show["id"], seat["id"])[0], 409)
        self.assertTrue(next(s for s in server.show_details(show["id"])["seats"] if s["id"] == seat["id"])["occupied"])
        self.assertEqual(server.finish_demo_payment(account["id"], payment["payment_id"], "4111111111111111")[0], 400)
        status, paid = server.finish_demo_payment(account["id"], payment["payment_id"], "4242 4242 4242 4242")
        self.assertEqual(status, 200)
        self.assertEqual(server.finish_demo_payment(account["id"], payment["payment_id"], "4242424242424242")[1]["token"], paid["token"])
        self.assertEqual(server.user_tickets(account["id"])[0]["token"], paid["token"])
        self.assertEqual(server.ticket_details(paid["token"])["customer_name"], "Зритель")
        server.delete_session(session)
        self.assertIsNone(server.user_from_token(session))

    def test_declined_demo_payment_releases_seat(self):
        _, account = server.register_user("viewer2@example.test", "Зритель", "demo-password-123")
        show = server.catalog()["shows"][0]
        seat = next(s for s in server.show_details(show["id"])["seats"] if not s["occupied"])
        _, payment = server.create_demo_payment(account["id"], show["id"], seat["id"])
        self.assertEqual(server.finish_demo_payment(account["id"], payment["payment_id"], "4000000000000002")[0], 402)
        self.assertFalse(next(s for s in server.show_details(show["id"])["seats"] if s["id"] == seat["id"])["occupied"])
        self.assertEqual(server.create_demo_payment(account["id"], show["id"], seat["id"])[0], 201)


if __name__ == "__main__":
    unittest.main()
