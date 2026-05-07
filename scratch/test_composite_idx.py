import os
import sys
from codegraphcontext.core import get_database_manager

db_manager = get_database_manager()
driver = db_manager.get_driver()

with driver.session() as session:
    try:
        print("Attempting to create composite index...")
        session.run("CREATE INDEX FOR (f:Function) ON (f.name, f.path, f.line_number)")
        print("Success!")
    except Exception as e:
        print(f"Failed: {e}")

db_manager.close_driver()
